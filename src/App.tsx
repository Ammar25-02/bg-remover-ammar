import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelKey, WorkerRequest, WorkerResponse } from './worker'
import './App.css'

type Background =
  | { kind: 'none' }
  | { kind: 'color'; value: string }
  | { kind: 'image'; img: HTMLImageElement; url: string }

type Result = { cutout: HTMLCanvasElement; device: string; ms: number }

const SWATCHES = ['#ffffff', '#000000', '#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#e5e7eb']

const MODEL_INFO: Record<ModelKey, { label: string; hint: string }> = {
  fast: { label: 'Fast', hint: 'People & portraits · ~7–26 MB' },
  best: { label: 'Best quality', hint: 'Any subject · ~44 MB' },
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not read this image'))
    img.src = url
  })

function compose(cutout: HTMLCanvasElement, bg: Background, target: HTMLCanvasElement) {
  const { width: w, height: h } = cutout
  target.width = w
  target.height = h
  const ctx = target.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  if (bg.kind === 'color') {
    ctx.fillStyle = bg.value
    ctx.fillRect(0, 0, w, h)
  } else if (bg.kind === 'image') {
    // object-fit: cover
    const s = Math.max(w / bg.img.width, h / bg.img.height)
    const dw = bg.img.width * s
    const dh = bg.img.height * s
    ctx.drawImage(bg.img, (w - dw) / 2, (h - dh) / 2, dw, dh)
  }
  ctx.drawImage(cutout, 0, 0)
}

export default function App() {
  const workerRef = useRef<Worker | null>(null)
  const jobRef = useRef(0)
  const startRef = useRef(0)
  const viewRef = useRef<HTMLCanvasElement>(null)
  const bgInput = useRef<HTMLInputElement>(null)

  const [model, setModel] = useState<ModelKey>('best')
  const [source, setSource] = useState<{ url: string; name: string; blob: Blob } | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState<Record<string, { loaded: number; total: number }>>({})
  const [error, setError] = useState('')
  const [bg, setBg] = useState<Background>({ kind: 'none' })
  const [split, setSplit] = useState(50)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === 'progress') {
        setProgress((p) => ({ ...p, [msg.file]: { loaded: msg.loaded, total: msg.total } }))
      } else if (msg.type === 'status') {
        setStatus(msg.message)
      } else if (msg.id !== jobRef.current) {
        return // a newer image was dropped in the meantime
      } else if (msg.type === 'done') {
        const cutout = document.createElement('canvas')
        cutout.width = msg.width
        cutout.height = msg.height
        const pixels = new ImageData(msg.data as Uint8ClampedArray<ArrayBuffer>, msg.width, msg.height)
        cutout.getContext('2d')!.putImageData(pixels, 0, 0)
        setResult({ cutout, device: msg.device, ms: performance.now() - startRef.current })
        setBusy(false)
        setStatus('')
        setProgress({})
      } else if (msg.type === 'error') {
        setError(msg.message)
        setBusy(false)
        setStatus('')
      }
    }
    workerRef.current = worker
    return () => worker.terminate()
  }, [])

  const run = useCallback((blob: Blob, which: ModelKey) => {
    const id = ++jobRef.current
    startRef.current = performance.now()
    setBusy(true)
    setError('')
    setResult(null)
    setStatus('Preparing…')
    workerRef.current?.postMessage({ type: 'remove', id, model: which, image: blob } satisfies WorkerRequest)
  }, [])

  const handleFile = useCallback(
    async (file: File | Blob | null | undefined, name = 'image') => {
      if (!file) return
      if (!file.type.startsWith('image/')) {
        setError('Please choose an image file (PNG, JPG, WebP).')
        return
      }
      const url = URL.createObjectURL(file)
      try {
        const img = await loadImage(url)
        setDims({ w: img.naturalWidth, h: img.naturalHeight })
      } catch (err) {
        URL.revokeObjectURL(url)
        setError((err as Error).message)
        return
      }
      setSource((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return { url, name: file instanceof File ? file.name : name, blob: file }
      })
      setSplit(50)
      run(file, model)
    },
    [model, run],
  )

  // Paste from clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
      if (item) handleFile(item.getAsFile(), 'pasted')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [handleFile])

  useEffect(() => {
    if (result && viewRef.current) compose(result.cutout, bg, viewRef.current)
  }, [result, bg])

  const changeModel = (m: ModelKey) => {
    setModel(m)
    if (source && !busy) run(source.blob, m)
  }

  const chooseBgImage = async (file?: File) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    try {
      const img = await loadImage(url)
      setBg((old) => {
        if (old.kind === 'image') URL.revokeObjectURL(old.url)
        return { kind: 'image', img, url }
      })
    } catch (err) {
      URL.revokeObjectURL(url)
      setError((err as Error).message)
    }
  }

  const download = () => {
    if (!result || !viewRef.current) return
    const base = (source?.name ?? 'image').replace(/\.[^.]+$/, '')
    viewRef.current.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${base}-no-bg.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    }, 'image/png')
  }

  const reset = () => {
    jobRef.current++
    if (source) URL.revokeObjectURL(source.url)
    setSource(null)
    setResult(null)
    setBusy(false)
    setError('')
    setStatus('')
    setProgress({})
  }

  const totals = Object.values(progress).reduce(
    (acc, p) => ({ loaded: acc.loaded + p.loaded, total: acc.total + p.total }),
    { loaded: 0, total: 0 },
  )
  const pct = totals.total ? Math.round((totals.loaded / totals.total) * 100) : null

  return (
    <div className="app">
      <header>
        <h1>
          Remove <span>background</span>
        </h1>
        <p>Automatic, free, and private. Your image never leaves this device.</p>
      </header>

      <div className="models" role="radiogroup" aria-label="Model">
        {(Object.keys(MODEL_INFO) as ModelKey[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={model === k}
            className={model === k ? 'active' : ''}
            onClick={() => changeModel(k)}
            disabled={busy}
          >
            <strong>{MODEL_INFO[k].label}</strong>
            <small>{MODEL_INFO[k].hint}</small>
          </button>
        ))}
      </div>

      {!source ? (
        <label
          className={`drop ${dragging ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            handleFile(e.dataTransfer.files[0])
          }}
        >
          <input type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
          <span className="btn primary">Upload image</span>
          <span className="muted">or drop a file, or paste with Ctrl+V</span>
        </label>
      ) : (
        <div className="workspace">
          <div
            className="stage"
            style={
              dims
                ? { aspectRatio: `${dims.w} / ${dims.h}`, width: `min(100%, calc(72vh * ${dims.w / dims.h}))` }
                : undefined
            }
          >
            <img className="layer" src={source.url} alt="Original" />
            {result && (
              <div className="layer checker" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
                <canvas ref={viewRef} className="layer" aria-label="Result" />
              </div>
            )}
            {result && (
              <>
                <div className="divider" style={{ left: `${split}%` }} />
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(e) => setSplit(+e.target.value)}
                  aria-label="Compare original and result"
                />
                <span className="tag left">Before</span>
                <span className="tag right">After</span>
              </>
            )}
            {busy && (
              <div className="overlay">
                <div className="spinner" />
                <p>{status}</p>
                {pct !== null && pct < 100 && (
                  <>
                    <div className="bar">
                      <div style={{ width: `${pct}%` }} />
                    </div>
                    <small>
                      Downloading model {pct}% of {(totals.total / 1e6).toFixed(0)} MB (first time only)
                    </small>
                  </>
                )}
              </div>
            )}
          </div>

          <aside className="panel">
            <h2>Background</h2>
            <div className="swatches">
              <button
                className={`swatch checker ${bg.kind === 'none' ? 'active' : ''}`}
                title="Transparent"
                aria-label="Transparent"
                onClick={() => setBg({ kind: 'none' })}
              />
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  className={`swatch ${bg.kind === 'color' && bg.value === c ? 'active' : ''}`}
                  style={{ background: c }}
                  title={c}
                  aria-label={`Color ${c}`}
                  onClick={() => setBg({ kind: 'color', value: c })}
                />
              ))}
              <label className="swatch picker" title="Custom color">
                <input type="color" onChange={(e) => setBg({ kind: 'color', value: e.target.value })} />
              </label>
            </div>
            <button className="btn" onClick={() => bgInput.current?.click()}>
              Use a photo as background
            </button>
            <input
              ref={bgInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => chooseBgImage(e.target.files?.[0])}
            />

            <div className="actions">
              <button className="btn primary" disabled={!result} onClick={download}>
                Download PNG
              </button>
              <button className="btn" onClick={reset}>
                New image
              </button>
            </div>

            {result && (
              <p className="muted small">
                {result.cutout.width}×{result.cutout.height}px · {(result.ms / 1000).toFixed(1)}s on{' '}
                {result.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'}
              </p>
            )}
          </aside>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="muted small">
        Models: ormbg and MODNet (both Apache-2.0), run with Transformers.js.
      </footer>
    </div>
  )
}
