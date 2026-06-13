# A local AI server

Gemma Agent never sends your code to the cloud. It connects to a model server
running on your own machine.

**Recommended:** [Ollama](https://ollama.com) — it can download and manage
models for you.

**Also supported** (OpenAI-compatible): LM Studio, Jan, llama.cpp `llama-server`,
vLLM, LocalAI. Point `gemmaAgent.ollamaUrl` at them and set
`gemmaAgent.apiProtocol` to `openai-compatible`.

Once installed, the setup panel in the Gemma sidebar guides you the rest of the way.
