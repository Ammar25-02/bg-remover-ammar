import { pipeline, RawImage, type BackgroundRemovalPipeline } from '@huggingface/transformers'

export type ModelKey = 'fast' | 'best'

export type WorkerRequest = { type: 'remove'; id: number; model: ModelKey; image: Blob }

export type WorkerResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'status'; message: string }
  | { type: 'done'; id: number; width: number; height: number; data: Uint8ClampedArray; device: string }
  | { type: 'error'; id: number; message: string }

const MODELS: Record<ModelKey, { id: string; dtype: { webgpu: string; wasm: string } }> = {
  // MODNet (Apache-2.0): small, tuned for people/portraits.
  fast: { id: 'Xenova/modnet', dtype: { webgpu: 'fp32', wasm: 'q8' } },
  // ormbg (Apache-2.0): larger, works on any subject (products, animals, objects).
  // BiRefNet-lite was tried first but exceeds WASM memory and some GPUs' shader limits.
  best: { id: 'onnx-community/ormbg-ONNX', dtype: { webgpu: 'fp16', wasm: 'q8' } },
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

const hasWebGPU = async () => {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return !!gpu && !!(await gpu.requestAdapter())
  } catch {
    return false
  }
}

type Device = 'webgpu' | 'wasm'
type Loaded = { remover: BackgroundRemovalPipeline; device: Device }

const cache = new Map<ModelKey, Promise<Loaded>>()
// Models whose WebGPU run failed on this GPU (e.g. shader limits); use CPU for them from now on.
const gpuBroken = new Set<ModelKey>()

const load = (key: ModelKey) => {
  let entry = cache.get(key)
  if (!entry) {
    entry = (async (): Promise<Loaded> => {
      const device: Device = !gpuBroken.has(key) && (await hasWebGPU()) ? 'webgpu' : 'wasm'
      const { id, dtype } = MODELS[key]
      post({ type: 'status', message: `Loading model (${device === 'webgpu' ? 'GPU' : 'CPU'})…` })
      const remover = (await pipeline('background-removal', id, {
        device,
        dtype: dtype[device] as 'fp32',
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === 'progress' && p.file && p.total) {
            post({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total })
          }
        },
      })) as unknown as BackgroundRemovalPipeline
      return { remover, device }
    })()
    entry.catch(() => cache.delete(key))
    cache.set(key, entry)
  }
  return entry
}

const removeWith = async (model: ModelKey, input: RawImage) => {
  let loaded: Loaded | undefined
  try {
    // Loading can already fail on WebGPU (session warm-up), so it stays inside the try.
    loaded = await load(model)
    post({ type: 'status', message: 'Removing background…' })
    return { out: (await loaded.remover(input)) as RawImage, device: loaded.device }
  } catch (err) {
    if (gpuBroken.has(model) || loaded?.device === 'wasm') throw err
    console.warn('WebGPU failed, retrying on CPU:', err)
    gpuBroken.add(model)
    cache.delete(model)
    await loaded?.remover.dispose().catch(() => {})
    const retry = await load(model)
    post({ type: 'status', message: 'Removing background (CPU)…' })
    return { out: (await retry.remover(input)) as RawImage, device: retry.device }
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, model, image } = e.data
  try {
    const input = await RawImage.fromBlob(image)
    const { out, device } = await removeWith(model, input)
    const rgba = out.channels === 4 ? out : out.rgba()
    const data = new Uint8ClampedArray(rgba.data)
    post({ type: 'done', id, width: rgba.width, height: rgba.height, data, device }, [data.buffer])
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}
