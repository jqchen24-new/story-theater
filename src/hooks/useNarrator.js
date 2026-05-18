import { useCallback, useEffect, useRef, useState } from 'react'
import { isIOSLikeDevice } from '../lib/platform.js'
import {
  sentenceIndexForCharPosition,
  sentenceIndexForRatio,
  splitNarrationSentences,
} from '../lib/narrationSentences.js'
import { pickVoiceForNarration } from '../lib/pickSpeechVoice.js'
import {
  getTtsHtmlAudio,
  getTtsNeuralCache,
  getTtsObjectUrl,
  hasTtsNeuralCache,
  isCachedHtmlAudioElement,
  isCachedTtsObjectUrl,
  pauseAllTtsPlayback,
  predecodeTtsBuffer,
  prepareCachedHtmlAudio,
  setTtsNeuralCache,
  waitForCachedAudioReady,
} from '../lib/ttsNeuralCache.js'
import {
  isNeuralTtsQuotaPaused,
  markNeuralTtsQuotaPaused,
} from '../lib/ttsQuotaPause.js'

/**
 * @param {string} text
 * @param {AbortSignal} signal
 * @returns {Promise<{ ab: ArrayBuffer, mime: string } | null>}
 */
async function fetchNeuralTtsWithRetry(text, signal) {
  if (isNeuralTtsQuotaPaused()) {
    return null
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    const ctRaw = res.headers.get('content-type') ?? ''
    const ct = ctRaw.toLowerCase()
    if (res.ok) {
      const blob = await res.blob()
      const looksLikeJsonError = ct.includes('application/json')
      if (blob.size >= 64 && !looksLikeJsonError) {
        const mimeFromHeader =
          ctRaw.split(';')[0].trim() || blob.type || 'audio/mpeg'
        const ab = await blob.arrayBuffer()
        return { ab, mime: mimeFromHeader }
      }
    }

    let errorCode = ''
    if (ct.includes('application/json')) {
      try {
        const j = await res.json()
        if (typeof j?.code === 'string') errorCode = j.code
      } catch {
        /* ignore */
      }
    }

    if (errorCode === 'TTS_QUOTA_EXHAUSTED' || res.status === 503) {
      markNeuralTtsQuotaPaused()
      return null
    }

    const transient =
      res.status === 500 || res.status === 502
    if (attempt === 0 && transient && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 480))
      continue
    }
    break
  }
  return null
}

/**
 * Read-aloud: prefers **neural TTS** via `POST /api/tts` (OpenAI or Gemini, server key) when configured,
 * otherwise **Web Speech** in the browser (robotic ceiling).
 *
 * Neural audio often needs an unlocked Web Audio context (call `primePlaybackFromGesture` from
 * real user input before async work) so playback still works after `await fetch`.
 */
export function useNarrator() {
  const [status, setStatus] = useState('idle')
  const [activeSentenceIndex, setActiveSentenceIndex] = useState(-1)
  const [supported] = useState(
    () =>
      typeof window !== 'undefined' &&
      (typeof window.speechSynthesis !== 'undefined' || typeof Audio !== 'undefined'),
  )
  const [iosSpeechGestureOnly] = useState(() => isIOSLikeDevice())

  const audioRef = useRef(null)
  const objectUrlRef = useRef(null)
  const abortRef = useRef(null)
  const audioContextRef = useRef(null)
  const bufferSourceRef = useRef(null)
  /** Every live Web Audio buffer source (stop all on cleanup — ref alone can miss orphans). */
  const activeBufferSourcesRef = useRef(/** @type {Set<AudioBufferSourceNode>} */ (new Set()))
  /** Pending Web Speech start (setTimeout after synth.cancel). */
  const speechDelayTimerRef = useRef(0)
  /** Cached neural response for instant replay / iOS prefetch. */
  const prefetchedRef = useRef(null)
  const prefetchAbortRef = useRef(null)
  /** Avoid aborting an in-flight `/api/tts` when the same narration is prefetched twice (e.g. after fetch + effect). */
  const prefetchInFlightKeyRef = useRef(/** @type {string | null} */ (null))
  const speakGenRef = useRef(0)
  /** Sentence spans for whichever text is currently being read aloud. */
  const sentencesRef = useRef(
    /** @type {Array<{ text: string, start: number, end: number }>} */ ([]),
  )
  /** rAF id for Web Audio playback tracking. */
  const rafIdRef = useRef(0)

  const cancelSentenceTracking = useCallback(() => {
    if (rafIdRef.current && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(rafIdRef.current)
    }
    rafIdRef.current = 0
  }, [])

  const updateActiveFromCharPos = useCallback((pos) => {
    const idx = sentenceIndexForCharPosition(sentencesRef.current, pos)
    setActiveSentenceIndex((prev) => (prev === idx ? prev : idx))
  }, [])

  const updateActiveFromRatio = useCallback((ratio) => {
    const idx = sentenceIndexForRatio(sentencesRef.current, ratio)
    setActiveSentenceIndex((prev) => (prev === idx ? prev : idx))
  }, [])

  const stopAllBufferSources = useCallback(() => {
    for (const src of activeBufferSourcesRef.current) {
      try {
        src.stop(0)
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect()
      } catch {
        /* ignore */
      }
    }
    activeBufferSourcesRef.current.clear()
    bufferSourceRef.current = null
  }, [])

  const cleanupAudio = useCallback(() => {
    if (speechDelayTimerRef.current) {
      clearTimeout(speechDelayTimerRef.current)
      speechDelayTimerRef.current = 0
    }
    cancelSentenceTracking()
    abortRef.current?.abort()
    abortRef.current = null
    stopAllBufferSources()
    pauseAllTtsPlayback()
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    const ctx = audioContextRef.current
    if (ctx && ctx.state === 'running') {
      void ctx.suspend()
    }
    if (audioRef.current) {
      const audio = audioRef.current
      audio.pause()
      if (isCachedHtmlAudioElement(audio)) {
        audio.currentTime = 0
      } else {
        audio.removeAttribute('src')
        audio.load()
      }
      audio.ontimeupdate = null
      audio.onended = null
      audio.onerror = null
      audioRef.current = null
    }
    if (objectUrlRef.current) {
      if (!isCachedTtsObjectUrl(objectUrlRef.current)) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
      objectUrlRef.current = null
    }
  }, [cancelSentenceTracking, stopAllBufferSources])

  /** Call synchronously from pointer/tap handlers so neural audio can play after async fetch. */
  const primePlaybackFromGesture = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      if (!audioContextRef.current) {
        audioContextRef.current = new AC()
      }
      const ctx = audioContextRef.current
      if (ctx.state === 'suspended') {
        void ctx.resume()
      }
    } catch {
      /* ignore */
    }
  }, [])

  const stop = useCallback(() => {
    speakGenRef.current += 1
    prefetchAbortRef.current?.abort()
    prefetchAbortRef.current = null
    prefetchInFlightKeyRef.current = null
    prefetchedRef.current = null
    cleanupAudio()
    setStatus('idle')
    setActiveSentenceIndex(-1)
  }, [cleanupAudio])

  /** Warm `/api/tts` while the user reads (iOS has no auto-speak). */
  const prefetchNarration = useCallback((text) => {
    if (typeof window === 'undefined') return
    if (isNeuralTtsQuotaPaused()) return
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t) return

    const cached = getTtsNeuralCache(t)
    if (cached?.ab?.byteLength >= 64) {
      prefetchAbortRef.current?.abort()
      prefetchAbortRef.current = null
      prefetchInFlightKeyRef.current = null
      prefetchedRef.current = { key: t, ab: cached.ab.slice(0), mime: cached.mime }
      getTtsObjectUrl(t)
      void prepareCachedHtmlAudio(t)
      const ctx = audioContextRef.current
      if (ctx) void predecodeTtsBuffer(t, ctx)
      return
    }

    if (prefetchInFlightKeyRef.current === t) {
      return
    }

    prefetchAbortRef.current?.abort()
    prefetchInFlightKeyRef.current = t
    const ac = new AbortController()
    prefetchAbortRef.current = ac

    void (async () => {
      try {
        const hit = getTtsNeuralCache(t)
        if (hit?.ab?.byteLength >= 64) {
          if (ac.signal.aborted) return
          prefetchedRef.current = { key: t, ab: hit.ab.slice(0), mime: hit.mime }
          getTtsObjectUrl(t)
          void prepareCachedHtmlAudio(t)
          const ctx = audioContextRef.current
          if (ctx) void predecodeTtsBuffer(t, ctx)
          return
        }
        const fetched = await fetchNeuralTtsWithRetry(t, ac.signal)
        if (!fetched || ac.signal.aborted) return
        prefetchedRef.current = { key: t, ab: fetched.ab.slice(0), mime: fetched.mime }
        setTtsNeuralCache(t, fetched.ab.slice(0), fetched.mime)
        const ctx = audioContextRef.current
        if (ctx) void predecodeTtsBuffer(t, ctx)
        void prepareCachedHtmlAudio(t)
      } catch {
        /* aborted or network */
      } finally {
        if (prefetchInFlightKeyRef.current === t) {
          prefetchInFlightKeyRef.current = null
        }
        if (prefetchAbortRef.current === ac) {
          prefetchAbortRef.current = null
        }
      }
    })()
  }, [])

  /** Prime voice list for Web Speech fallback. */
  useEffect(() => {
    if (!supported || typeof window === 'undefined' || !window.speechSynthesis) return
    const synth = window.speechSynthesis
    const kick = () => {
      synth.getVoices()
    }
    kick()
    synth.addEventListener('voiceschanged', kick)
    return () => synth.removeEventListener('voiceschanged', kick)
  }, [supported])

  const speak = useCallback(
    async (text) => {
      if (typeof window === 'undefined') return
      const t = typeof text === 'string' ? text.trim() : ''
      if (!t) return

      const myGen = ++speakGenRef.current

      prefetchAbortRef.current?.abort()
      prefetchAbortRef.current = null

      cleanupAudio()
      let synthNeedsDelay = false
      if (window.speechSynthesis) {
        const synth = window.speechSynthesis
        synthNeedsDelay = synth.speaking || synth.pending
        synth.cancel()
      }

      sentencesRef.current = splitNarrationSentences(t)
      setActiveSentenceIndex(-1)
      const replayCached = hasTtsNeuralCache(t)
      const quotaPaused = isNeuralTtsQuotaPaused()
      if (replayCached) {
        primePlaybackFromGesture()
      }
      setStatus(replayCached ? 'playing' : 'loading')

      const bindHtmlAudioPlayback = (audio) => {
        const audioGen = myGen
        audio.onended = () => {
          if (audioRef.current === audio) {
            audioRef.current = null
          }
          if (speakGenRef.current === audioGen) {
            setStatus('idle')
            setActiveSentenceIndex(-1)
          }
        }
        audio.onerror = () => {
          if (audioRef.current === audio) {
            audioRef.current = null
          }
          if (speakGenRef.current === audioGen) {
            setStatus('idle')
            setActiveSentenceIndex(-1)
          }
        }
        audio.ontimeupdate = () => {
          if (speakGenRef.current !== audioGen) return
          const dur = audio.duration
          if (!Number.isFinite(dur) || dur <= 0) return
          updateActiveFromRatio(audio.currentTime / dur)
        }
      }

      const playHtmlAudioElement = async (audio, urlForRef) => {
        if (speakGenRef.current !== myGen) return false

        stopAllBufferSources()
        pauseAllTtsPlayback()

        objectUrlRef.current = urlForRef ?? audio.src ?? null
        audioRef.current = audio
        bindHtmlAudioPlayback(audio)

        try {
          audio.currentTime = 0
          setStatus('playing')
          await audio.play()
          return speakGenRef.current === myGen
        } catch {
          if (audioRef.current === audio) {
            audioRef.current = null
          }
          return false
        }
      }

      const playWithHtmlAudio = async (url) => {
        const audio = new Audio()
        try {
          audio.setAttribute('playsinline', '')
          audio.playsInline = true
        } catch {
          /* ignore */
        }
        audio.volume = 1
        audio.src = url
        audio.preload = 'auto'
        return playHtmlAudioElement(audio, url)
      }

      const tryPlayFromBufferSource = async (audioBuffer) => {
        const ctx = audioContextRef.current
        if (!ctx || ctx.state === 'closed' || speakGenRef.current !== myGen) return false
        if (ctx.state === 'suspended') {
          try {
            await ctx.resume()
          } catch {
            return false
          }
        }
        if (ctx.state !== 'running') return false

        try {
          stopAllBufferSources()
          pauseAllTtsPlayback()

          const source = ctx.createBufferSource()
          bufferSourceRef.current = source
          activeBufferSourcesRef.current.add(source)
          source.buffer = audioBuffer
          source.connect(ctx.destination)
          const sourceGen = myGen
          source.onended = () => {
            activeBufferSourcesRef.current.delete(source)
            bufferSourceRef.current = null
            cancelSentenceTracking()
            if (speakGenRef.current === sourceGen) {
              setStatus('idle')
              setActiveSentenceIndex(-1)
            }
          }
          setStatus('playing')
          source.start(0)
          const ctxStart = ctx.currentTime
          const duration = audioBuffer.duration
          cancelSentenceTracking()
          const tick = () => {
            if (speakGenRef.current !== sourceGen) return
            if (bufferSourceRef.current !== source) return
            if (ctx.state === 'running' && Number.isFinite(duration) && duration > 0) {
              updateActiveFromRatio((ctx.currentTime - ctxStart) / duration)
            }
            rafIdRef.current = requestAnimationFrame(tick)
          }
          rafIdRef.current = requestAnimationFrame(tick)
          return true
        } catch {
          stopAllBufferSources()
          return false
        }
      }

      /**
       * @param {ArrayBuffer} ab
       * @param {string} mimeFromHeader
       */
      const tryPlayNeuralAb = async (ab, mimeFromHeader) => {
        if (speakGenRef.current !== myGen) return false

        prefetchedRef.current = { key: t, ab: ab.slice(0), mime: mimeFromHeader }

        const entry = getTtsNeuralCache(t)
        const ctx = audioContextRef.current
        if (ctx && ctx.state !== 'closed') {
          if (ctx.state === 'suspended') {
            try {
              await ctx.resume()
            } catch {
              /* ignore */
            }
          }
          if (ctx.state === 'running') {
            if (entry?.audioBuffer) {
              const ok = await tryPlayFromBufferSource(entry.audioBuffer)
              if (ok) return true
            }
            try {
              const audioBuffer = await new Promise((resolve, reject) => {
                void ctx.decodeAudioData(ab.slice(0), resolve, reject)
              })
              if (speakGenRef.current !== myGen) return false
              if (entry) entry.audioBuffer = audioBuffer
              const ok = await tryPlayFromBufferSource(audioBuffer)
              if (ok) return true
            } catch {
              stopAllBufferSources()
            }
          }
        }

        if (speakGenRef.current !== myGen) return false

        const url =
          getTtsObjectUrl(t) ??
          URL.createObjectURL(new Blob([ab], { type: mimeFromHeader }))
        return playWithHtmlAudio(url)
      }

      const tryPlayFromCache = async () => {
        const entry = getTtsNeuralCache(t)
        if (!entry?.ab || entry.ab.byteLength < 64) return false

        prefetchedRef.current = { key: t, ab: entry.ab.slice(0), mime: entry.mime }

        const cachedAudio = getTtsHtmlAudio(t)
        if (cachedAudio) {
          if (cachedAudio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForCachedAudioReady(cachedAudio, 2500)
          }
          if (speakGenRef.current !== myGen) return false
          const url = entry.objectUrl ?? cachedAudio.src
          const ok = await playHtmlAudioElement(cachedAudio, url)
          if (ok) return true
        }

        if (entry.audioBuffer) {
          const ok = await tryPlayFromBufferSource(entry.audioBuffer)
          if (ok) return true
        }

        const url = getTtsObjectUrl(t)
        if (url) {
          return playWithHtmlAudio(url)
        }
        return false
      }

      try {
        if (replayCached) {
          const ok = await tryPlayFromCache()
          if (ok && speakGenRef.current === myGen) return
          if (speakGenRef.current !== myGen) return
          /* Fall through to fetch/Web Speech instead of going silent. */
          setStatus('loading')
        }

        const cached = prefetchedRef.current
        if (cached?.key === t && cached.ab.byteLength >= 64) {
          const ok = await tryPlayNeuralAb(cached.ab.slice(0), cached.mime)
          if (ok && speakGenRef.current === myGen) return
        }

        if (speakGenRef.current !== myGen) return

        if (!quotaPaused) {
          abortRef.current = new AbortController()
          const fetched = await fetchNeuralTtsWithRetry(t, abortRef.current.signal)

          if (speakGenRef.current !== myGen) return

          if (fetched && fetched.ab.byteLength >= 64) {
            setTtsNeuralCache(t, fetched.ab.slice(0), fetched.mime)
            const ctx = audioContextRef.current
            if (ctx) predecodeTtsBuffer(t, ctx)
            void prepareCachedHtmlAudio(t)
            const ok = await tryPlayNeuralAb(fetched.ab.slice(0), fetched.mime)
            if (ok && speakGenRef.current === myGen) return
          }
        }
      } catch (e) {
        if (e?.name === 'AbortError') {
          if (speakGenRef.current === myGen) setStatus('idle')
          return
        }
        cleanupAudio()
      }

      if (!window.speechSynthesis) {
        if (speakGenRef.current === myGen) setStatus('idle')
        return
      }

      const synth = window.speechSynthesis
      try {
        if (synth.paused) synth.resume()
      } catch {
        /* ignore */
      }

      const runSpeak = () => {
        if (speakGenRef.current !== myGen) return
        try {
          if (synth.paused) synth.resume()
        } catch {
          /* ignore */
        }

        void synth.getVoices()

        const u = new SpeechSynthesisUtterance(t)
        u.lang = 'en-US'
        u.rate = iosSpeechGestureOnly ? 0.9 : 0.86
        u.pitch = iosSpeechGestureOnly ? 1 : 1.04
        u.volume = 1

        const voice = pickVoiceForNarration(synth, { iosConservative: iosSpeechGestureOnly })
        if (voice) {
          u.voice = voice
        }

        u.onboundary = (e) => {
          if (speakGenRef.current !== myGen) return
          if (typeof e.charIndex === 'number') {
            updateActiveFromCharPos(e.charIndex)
          }
        }
        u.onstart = () => {
          if (speakGenRef.current !== myGen) return
          if (sentencesRef.current.length > 0) {
            updateActiveFromCharPos(0)
          }
        }
        u.onend = () => {
          if (speakGenRef.current === myGen) {
            setStatus('idle')
            setActiveSentenceIndex(-1)
          }
        }
        u.onerror = () => {
          if (speakGenRef.current === myGen) {
            setStatus('idle')
            setActiveSentenceIndex(-1)
          }
        }

        setStatus('playing')
        synth.speak(u)

        window.requestAnimationFrame(() => {
          try {
            if (synth.paused) synth.resume()
          } catch {
            /* ignore */
          }
        })
      }

      if (iosSpeechGestureOnly) {
        runSpeak()
      } else if (synthNeedsDelay) {
        /* Chrome/Safari: synth.cancel() then immediate speak() can hang the engine for seconds. */
        speechDelayTimerRef.current = window.setTimeout(() => {
          speechDelayTimerRef.current = 0
          runSpeak()
        }, 80)
      } else {
        queueMicrotask(runSpeak)
      }
    },
    [
      cancelSentenceTracking,
      cleanupAudio,
      iosSpeechGestureOnly,
      stopAllBufferSources,
      updateActiveFromCharPos,
      updateActiveFromRatio,
      primePlaybackFromGesture,
    ],
  )

  const togglePause = useCallback(() => {
    if (typeof window === 'undefined') return

    if (status === 'loading') {
      speakGenRef.current += 1
      cleanupAudio()
      setStatus('idle')
      return
    }

    if (bufferSourceRef.current && audioContextRef.current) {
      const ctx = audioContextRef.current
      if (ctx.state === 'running') {
        void ctx.suspend()
        setStatus('paused')
      } else if (ctx.state === 'suspended') {
        void ctx.resume()
        setStatus('playing')
      }
      return
    }

    const audio = audioRef.current
    if (audio) {
      if (audio.paused) {
        void audio.play()
        setStatus('playing')
      } else {
        audio.pause()
        setStatus('paused')
      }
      return
    }

    if (!window.speechSynthesis) return
    const synth = window.speechSynthesis
    if (!synth.speaking) return
    if (synth.paused) {
      synth.resume()
      setStatus('playing')
    } else {
      synth.pause()
      setStatus('paused')
    }
  }, [status, cleanupAudio])

  useEffect(() => {
    return () => {
      prefetchAbortRef.current?.abort()
      prefetchedRef.current = null
      cleanupAudio()
      try {
        void audioContextRef.current?.close()
      } catch {
        /* ignore */
      }
      audioContextRef.current = null
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
    }
  }, [cleanupAudio])

  return {
    speak,
    stop,
    togglePause,
    primePlaybackFromGesture,
    prefetchNarration,
    status,
    supported,
    iosSpeechGestureOnly,
    activeSentenceIndex,
  }
}
