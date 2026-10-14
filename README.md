# Background Remover

A remove.bg-style background remover that runs entirely in the browser. Images never leave the device.

- **Fast**: [MODNet](https://huggingface.co/Xenova/modnet) (Apache-2.0), best for people and portraits.
- **Best quality**: [ormbg](https://huggingface.co/onnx-community/ormbg-ONNX) (Apache-2.0), works on any subject.

Runs on the GPU via WebGPU when available, and falls back to CPU (WASM) otherwise.
Models download from Hugging Face on first use and are cached by the browser.

## Develop

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo (branch `main`).
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. Every push to `main` builds and deploys via `.github/workflows/deploy.yml`.
