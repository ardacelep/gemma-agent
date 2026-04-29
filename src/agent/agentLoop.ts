import { OllamaMessage, ollamaChat } from '../ollama/client';
import { executeTool, ToolCall } from './tools';

export const AGENT_SYSTEM_PROMPT = `Sen bir yazılım geliştirme asistanısın. Dosya sistemi araçlarına erişimin var.

Araçları kullanmak için şu formatı kullan — başka bir şey ekleme:
<tool_call>
{"tool":"<isim>", ...argümanlar}
</tool_call>

Kullanılabilir araçlar:

create_file — Dosya oluşturur veya üzerine yazar
{"tool":"create_file","path":"src/hello.ts","content":"console.log('merhaba')"}

edit_file — Dosyada metin değiştirir (search tam eşleşme)
{"tool":"edit_file","path":"src/hello.ts","search":"eski metin","replace":"yeni metin"}

read_file — Dosya içeriğini okur
{"tool":"read_file","path":"src/hello.ts"}

list_files — Dizin içeriğini listeler
{"tool":"list_files","path":"src"}

search_files — Workspace'te metin arar
{"tool":"search_files","query":"aranacak metin","path":"src"}

run_command — Terminalde komut çalıştırır
{"tool":"run_command","command":"npm install"}

Kurallar:
- Araç çağrısı yapacaksan SADECE <tool_call> bloğu yaz, başka metin ekleme.
- Araç sonuçlarını aldıktan sonra kullanıcıya ne yaptığını açıkla.
- Birden fazla araç gerekiyorsa sırayla kullan, her seferinde bir tane.
- Türkçe konuş.`;

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;

/** Strip markdown link syntax from file paths: [name](url) → name */
function stripMarkdownLink(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
}

/**
 * Parse tool call JSON from model output.
 * Models frequently produce two kinds of broken JSON:
 *   1. Unescaped double-quotes inside string values (e.g. `"__main__"`)
 *   2. Literal newlines inside string values instead of \n
 * We try standard parse first, then two repair passes.
 */
function parseToolCall(raw: string): ToolCall {
  // Pass 1 — standard parse
  try {
    return sanitizeToolCall(JSON.parse(raw));
  } catch { /* continue */ }

  // Pass 2 — replace literal newlines inside the JSON text with \n
  //           (only inside string values, i.e. between " pairs)
  let fixed = raw.replace(/("(?:[^"\\]|\\.)*")/gs, (m) =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
  );
  try {
    return sanitizeToolCall(JSON.parse(fixed));
  } catch { /* continue */ }

  // Pass 3 — extract fields individually with regex so the content field
  //           never breaks the parser (grab it as the remainder of the JSON)
  const tool = /"tool"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  if (!tool) throw new Error('tool alanı bulunamadı');

  const result: Record<string, unknown> = { tool };

  for (const key of ['path', 'command', 'query']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`).exec(raw);
    if (m) result[key] = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  // content — everything between `"content":` and the final `}`
  const contentStart = raw.indexOf('"content":');
  if (contentStart !== -1) {
    const afterKey = raw.slice(contentStart + 10).trimStart();
    if (afterKey.startsWith('"')) {
      // Grab until closing brace heuristically: strip leading quote and trailing "}
      let content = afterKey.slice(1);
      // Remove trailing `"}` or `" }` that closes the JSON object
      content = content.replace(/"\s*}?\s*$/, '');
      // Unescape sequences the model DID escape correctly
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      result['content'] = content;
    }
  }

  for (const key of ['search', 'replace']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`).exec(raw);
    if (m) result[key] = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }

  return sanitizeToolCall(result as ToolCall);
}

function sanitizeToolCall(call: ToolCall): ToolCall {
  // Strip markdown link syntax from path: [test.py](http://…) → test.py
  if (typeof call.path === 'string') call.path = stripMarkdownLink(call.path);
  if (typeof call.command === 'string') call.command = stripMarkdownLink(call.command);
  return call;
}

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  tool?: ToolCall;
  result?: { ok: boolean; output: string };
}

export async function* runAgentLoop(
  userMessage: string,
  history: OllamaMessage[],
  signal: AbortSignal,
  maxIterations = 10
): AsyncGenerator<AgentEvent> {
  // Strip markdown link syntax from user message so model doesn't copy it into paths
  const cleanedMessage = userMessage.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  const messages: OllamaMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: cleanedMessage },
  ];

  for (let i = 0; i < maxIterations; i++) {
    if (signal.aborted) break;

    // Collect model response
    let raw = '';
    try {
      for await (const chunk of ollamaChat({ messages, signal })) {
        raw += chunk;
        // Stream text chunks only if we're not inside a tool_call block
        if (!raw.includes('<tool_call>')) {
          yield { type: 'text', text: chunk };
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        yield { type: 'error', text: (err as Error).message };
      }
      break;
    }

    // Check for tool call
    const match = raw.match(TOOL_CALL_RE);
    if (!match) {
      // No tool call — agent is done
      // If we suppressed streaming above for a non-tool message, emit whole text
      if (raw.includes('<tool_call>')) {
        // Malformed tool call — emit what came before it
        const before = raw.split('<tool_call>')[0].trim();
        if (before) yield { type: 'text', text: before };
      }
      yield { type: 'done' };
      return;
    }

    // Emit any text that preceded the tool call
    const before = raw.split('<tool_call>')[0].trim();
    if (before) yield { type: 'text', text: before };

    // Parse and execute tool
    let toolCall: ToolCall;
    try {
      toolCall = parseToolCall(match[1]);
    } catch (e) {
      yield { type: 'error', text: `Araç çağrısı parse edilemedi: ${(e as Error).message}` };
      yield { type: 'done' };
      return;
    }

    yield { type: 'tool_call', tool: toolCall };

    const result = await executeTool(toolCall);

    yield { type: 'tool_result', result };

    // Feed result back into conversation
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `Araç sonucu (${toolCall.tool}): ${result.ok ? 'BAŞARILI' : 'HATA'}\n${result.output}`,
    });
  }

  yield { type: 'done' };
}
