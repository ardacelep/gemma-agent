# Download a model

The default model is **gemma4:e4b** — a good balance of speed and quality.

With Ollama, Gemma Agent can pull models for you with a progress bar from the
setup panel or the model picker. Or run it yourself:

```
ollama pull gemma4:e4b
```

Smaller/faster options: `gemma3:1b`, `gemma3:4b`. Larger/stronger: `gemma3:12b`,
`gemma3:27b`. You can set a separate, faster model just for inline completion
via `gemmaAgent.completionModel`.
