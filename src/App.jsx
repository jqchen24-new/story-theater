import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChoiceCards } from './components/ChoiceCards.jsx'
import { EndingScreen } from './components/EndingScreen.jsx'
import { SceneDisplay } from './components/SceneDisplay.jsx'
import { SetupScreen } from './components/SetupScreen.jsx'
import { useNarrator } from './hooks/useNarrator.js'
import { warmTtsNeuralCaches } from './lib/ttsNeuralCache.js'
import { aggregateCastFromPages } from './lib/illustrationCastMap.js'
import { fetchSceneIllustration, fetchStoryScene } from './lib/storyEngine.js'
import { isIOSLikeDevice } from './lib/platform.js'

/**
 * @typedef {{ choiceHistory: string[], scene: object, phase: 'scene' | 'ending' }} StoryPage
 */

const EMPTY_CHOICE_HISTORY = Object.freeze([])

/** Lowercase genre phrase for play-again copy (matches SetupScreen labels). */
const GENRE_LABELS = Object.freeze({
  Adventure: 'adventure',
  Magic: 'magic',
  Animals: 'animals',
  Space: 'space',
  Mystery: 'mystery',
  Comedy: 'silly comedy',
  Fantasy: 'fantasy',
  Ocean: 'ocean',
  Fairytale: 'fairytale',
  Superheroes: 'superheroes',
  Dinosaurs: 'dinosaurs',
  Sports: 'sports',
  Robots: 'robots',
  Woodland: 'woodland',
  Pirates: 'pirates',
  TimeTravel: 'time travel',
})

export default function App() {
  const [storyPages, setStoryPages] = useState(
    /** @type {StoryPage[]} */ ([]),
  )
  const [pageIndex, setPageIndex] = useState(0)
  const [genre, setGenre] = useState('Adventure')
  const [heroName, setHeroName] = useState('')
  const [heroGender, setHeroGender] = useState(
    /** @type {'girl' | 'boy' | 'neutral'} */ ('neutral'),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [illustrationUrl, setIllustrationUrl] = useState(null)
  const [illustrationStatus, setIllustrationStatus] = useState('idle')
  const [illustrationDisableCode, setIllustrationDisableCode] = useState(null)
  const illustrationsOffRef = useRef(false)
  /** Data URLs keyed by choice path — avoids regenerating art when using prev/next. */
  const illustrationByPathKeyRef = useRef(/** @type {Record<string, string>} */ ({}))
  /** Scene 1 illustration — sent to Gemini for later scenes so the hero matches across pages. */
  const heroIllustrationAnchorRef = useRef(/** @type {string | null} */ (null))
  const storyPagesRef = useRef(/** @type {StoryPage[]} */ ([]))
  const pageIndexRef = useRef(0)

  useEffect(() => {
    storyPagesRef.current = storyPages
  }, [storyPages])

  useEffect(() => {
    pageIndexRef.current = pageIndex
  }, [pageIndex])

  const {
    speak,
    stop,
    togglePause,
    primePlaybackFromGesture,
    prefetchNarration,
    status: narratorStatus,
    supported: speechSupported,
    iosSpeechGestureOnly,
    activeSentenceIndex: narratorActiveSentenceIndex,
  } = useNarrator()

  const resolvedHero = useMemo(
    () => (heroName.trim() ? heroName.trim().slice(0, 40) : 'Hero'),
    [heroName],
  )

  const heroKey = useMemo(() => resolvedHero.trim().toLowerCase(), [resolvedHero])

  const playAgainCaption = useMemo(() => {
    const genrePhrase = GENRE_LABELS[genre] ?? genre.toLowerCase()
    return `Same hero (${resolvedHero}) and ${genrePhrase} world — a brand-new story, not a replay.`
  }, [genre, resolvedHero])

  const safePageIndex = useMemo(
    () => (storyPages.length === 0 ? 0 : Math.min(Math.max(0, pageIndex), storyPages.length - 1)),
    [storyPages.length, pageIndex],
  )

  const illustrationCastMap = useMemo(() => {
    if (storyPages.length === 0) return /** @type {Record<string, string>} */ ({})
    const path = storyPages.slice(0, safePageIndex + 1)
    return aggregateCastFromPages(path, heroKey)
  }, [storyPages, safePageIndex, heroKey])

  const phase = useMemo(() => {
    if (storyPages.length === 0) return 'setup'
    return storyPages[safePageIndex]?.phase === 'ending' ? 'ending' : 'scene'
  }, [storyPages, safePageIndex])

  const choiceHistory = useMemo(() => {
    const p = storyPages[safePageIndex]
    return p?.choiceHistory ?? EMPTY_CHOICE_HISTORY
  }, [storyPages, safePageIndex])

  const currentScene = storyPages[safePageIndex]?.scene ?? null

  const canGoStoryBack = storyPages.length > 0 && safePageIndex > 0 && !loading
  const canGoStoryForward =
    storyPages.length > 0 && safePageIndex < storyPages.length - 1 && !loading

  useEffect(() => {
    const narrations = storyPages
      .map((p) => (typeof p.scene?.narration === 'string' ? p.scene.narration.trim() : ''))
      .filter(Boolean)
    warmTtsNeuralCaches(narrations)
  }, [storyPages])

  useEffect(() => {
    if (!iosSpeechGestureOnly) return
    if (!currentScene?.narration?.trim()) return
    if (loading) return
    if (phase !== 'scene' && phase !== 'ending') return
    prefetchNarration(currentScene.narration.trim())
  }, [currentScene?.narration, iosSpeechGestureOnly, loading, phase, prefetchNarration])

  useEffect(() => {
    if (iosSpeechGestureOnly) return
    if (!currentScene?.narration?.trim()) return
    if (loading) return
    if (phase !== 'scene' && phase !== 'ending') return

    const narration = currentScene.narration.trim()
    speak(narration)
    return () => {
      stop()
    }
  }, [phase, currentScene?.narration, loading, speak, stop, iosSpeechGestureOnly])

  const choiceHistoryKey = useMemo(() => choiceHistory.join('\u0001'), [choiceHistory])

  useEffect(() => {
    if (illustrationsOffRef.current) return
    const narration = currentScene?.narration?.trim()
    if (!narration || (phase !== 'scene' && phase !== 'ending')) {
      return
    }

    const pathKey = `${heroGender}\u0001${choiceHistoryKey}`
    const choiceParts = choiceHistoryKey ? choiceHistoryKey.split('\u0001') : []
    const sceneNumber = choiceParts.length + 1
    const lastChoice = choiceParts.length > 0 ? choiceParts[choiceParts.length - 1].trim() : ''

    const cached = illustrationByPathKeyRef.current[pathKey]
    if (cached) {
      if (sceneNumber === 1) {
        heroIllustrationAnchorRef.current = cached
      }
      setIllustrationUrl(cached)
      setIllustrationStatus('ready')
      setIllustrationDisableCode(null)
      return
    }

    const ac = new AbortController()

    const scene1PathKey = `${heroGender}\u0001`
    const anchorFallback =
      heroIllustrationAnchorRef.current || illustrationByPathKeyRef.current[scene1PathKey]

    queueMicrotask(() => {
      if (ac.signal.aborted) return
      setIllustrationStatus('loading')
      setIllustrationUrl(null)
      setIllustrationDisableCode(null)

      void fetchSceneIllustration({
        narration,
        genre,
        heroName: resolvedHero,
        heroGender,
        heroReferenceImage:
          sceneNumber > 1 && anchorFallback ? anchorFallback : undefined,
        lastChoice,
        sceneNumber,
        establishedIllustrationCast: illustrationCastMap,
        signal: ac.signal,
      })
        .then((r) => {
          if (ac.signal.aborted) return
          if (r.disabled) {
            illustrationsOffRef.current = true
            setIllustrationStatus('off')
            setIllustrationUrl(null)
            setIllustrationDisableCode(r.disableCode ?? null)
            return
          }
          if (r.illustrationUrl) {
            illustrationByPathKeyRef.current[pathKey] = r.illustrationUrl
            if (sceneNumber === 1) {
              heroIllustrationAnchorRef.current = r.illustrationUrl
            }
            setIllustrationUrl(r.illustrationUrl)
            setIllustrationStatus('ready')
          } else {
            setIllustrationStatus('idle')
          }
        })
        .catch((e) => {
          if (ac.signal.aborted || e?.name === 'AbortError') return
          setIllustrationStatus('error')
          setIllustrationUrl(null)
        })
    })

    return () => ac.abort()
  }, [
    choiceHistoryKey,
    currentScene?.narration,
    phase,
    genre,
    resolvedHero,
    heroGender,
    illustrationCastMap,
  ])

  const startStory = useCallback(async () => {
    primePlaybackFromGesture()
    stop()
    setError(null)
    setLoading(true)
    if (typeof window !== 'undefined' && window.speechSynthesis && isIOSLikeDevice()) {
      void window.speechSynthesis.getVoices()
    }
    try {
      const scene = await fetchStoryScene({
        genre,
        heroName: resolvedHero,
        heroGender,
        sceneNumber: 1,
        choiceHistory: [],
        establishedIllustrationCast: {},
      })
      if (iosSpeechGestureOnly) {
        const n = typeof scene?.narration === 'string' ? scene.narration.trim() : ''
        if (n) prefetchNarration(n)
      }
      setStoryPages([
        {
          choiceHistory: [],
          scene,
          phase: scene.isEnding ? 'ending' : 'scene',
        },
      ])
      setPageIndex(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the story.')
    } finally {
      setLoading(false)
    }
  }, [genre, heroGender, resolvedHero, iosSpeechGestureOnly, prefetchNarration, stop, primePlaybackFromGesture])

  const choose = useCallback(
    async (label) => {
      const pages = storyPagesRef.current
      const idx = Math.min(
        Math.max(0, pageIndexRef.current),
        Math.max(0, pages.length - 1),
      )
      const page = pages[idx]
      if (!page?.scene || page.scene.isEnding || loading) return

      primePlaybackFromGesture()
      stop()
      const prevHistory = page.choiceHistory
      const nextHistory = [...prevHistory, label]
      setLoading(true)
      setError(null)

      try {
        const truncated = pages.slice(0, idx + 1)
        const castBase = aggregateCastFromPages(truncated, heroKey)
        const priorSceneNarrations = truncated
          .map((p) => (typeof p.scene?.narration === 'string' ? p.scene.narration.trim() : ''))
          .filter(Boolean)
        const scene = await fetchStoryScene({
          genre,
          heroName: resolvedHero,
          heroGender,
          sceneNumber: nextHistory.length + 1,
          choiceHistory: nextHistory,
          establishedIllustrationCast: castBase,
          priorSceneNarrations,
        })
        if (iosSpeechGestureOnly) {
          const n = typeof scene?.narration === 'string' ? scene.narration.trim() : ''
          if (n) prefetchNarration(n)
        }
        setStoryPages([
          ...truncated,
          {
            choiceHistory: nextHistory,
            scene,
            phase: scene.isEnding ? 'ending' : 'scene',
          },
        ])
        setPageIndex(truncated.length)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not continue the story.')
      } finally {
        setLoading(false)
      }
    },
    [
      genre,
      heroGender,
      heroKey,
      iosSpeechGestureOnly,
      loading,
      prefetchNarration,
      resolvedHero,
      stop,
      primePlaybackFromGesture,
    ],
  )

  const goStoryBack = useCallback(() => {
    if (!canGoStoryBack) return
    primePlaybackFromGesture()
    stop()
    setPageIndex((i) => Math.max(0, i - 1))
  }, [canGoStoryBack, stop, primePlaybackFromGesture])

  const goStoryForward = useCallback(() => {
    if (!canGoStoryForward) return
    primePlaybackFromGesture()
    stop()
    const max = storyPagesRef.current.length - 1
    setPageIndex((i) => Math.min(max, i + 1))
  }, [canGoStoryForward, stop, primePlaybackFromGesture])

  const resetStoryArtifacts = useCallback(() => {
    illustrationsOffRef.current = false
    illustrationByPathKeyRef.current = {}
    heroIllustrationAnchorRef.current = null
    setIllustrationUrl(null)
    setIllustrationStatus('idle')
    setIllustrationDisableCode(null)
  }, [])

  const goHome = useCallback(() => {
    resetStoryArtifacts()
    stop()
    setStoryPages([])
    setPageIndex(0)
    setError(null)
  }, [resetStoryArtifacts, stop])

  const playAgain = useCallback(async () => {
    if (loading) return
    resetStoryArtifacts()
    setError(null)
    await startStory()
  }, [loading, resetStoryArtifacts, startStory])

  const replayNarration = useCallback(() => {
    stop()
    primePlaybackFromGesture()
    const text = currentScene?.narration?.trim()
    if (text) {
      speak(text)
    }
  }, [currentScene, speak, stop, primePlaybackFromGesture])

  return (
    <div className="min-h-svh bg-gradient-to-b from-stone-900 via-stone-800 to-stone-900 text-stone-100">
      <main className="mx-auto flex min-h-svh max-w-3xl flex-col items-center pb-12 pt-4">
        {phase === 'setup' && (
          <SetupScreen
            genre={genre}
            onGenreChange={setGenre}
            heroName={heroName}
            onHeroNameChange={setHeroName}
            heroGender={heroGender}
            onHeroGenderChange={setHeroGender}
            onStart={startStory}
            loading={loading}
            error={error}
          />
        )}

        {phase === 'scene' && currentScene && (
          <>
            {error && (
              <p
                className="mb-4 max-w-2xl rounded-xl border border-red-500/50 bg-red-950/40 px-4 py-3 text-center text-base text-red-200"
                role="alert"
              >
                {error}
              </p>
            )}
            <SceneDisplay
              narration={currentScene.narration}
              sceneLabel={`Scene ${choiceHistory.length + 1} of 6`}
              narratorStatus={narratorStatus}
              narratorActiveSentenceIndex={narratorActiveSentenceIndex}
              speechSupported={speechSupported}
              iosSpeechGestureOnly={iosSpeechGestureOnly}
              onNarratorReplay={replayNarration}
              onNarratorTogglePause={togglePause}
              onNarratorStop={stop}
              onGoHome={goHome}
              onGoStoryBack={goStoryBack}
              onGoStoryForward={goStoryForward}
              canGoStoryBack={canGoStoryBack}
              canGoStoryForward={canGoStoryForward}
              storyNavDisabled={loading}
              loading={loading}
              illustrationUrl={illustrationUrl}
              illustrationStatus={illustrationStatus}
              illustrationDisableCode={illustrationDisableCode}
            >
              {!currentScene.isEnding && (
                <ChoiceCards
                  choices={currentScene.choices}
                  onChoose={choose}
                  disabled={loading}
                />
              )}
            </SceneDisplay>
          </>
        )}

        {phase === 'ending' && currentScene && (
          <EndingScreen
            narration={currentScene.narration}
            narratorStatus={narratorStatus}
            narratorActiveSentenceIndex={narratorActiveSentenceIndex}
            speechSupported={speechSupported}
            iosSpeechGestureOnly={iosSpeechGestureOnly}
            onNarratorReplay={replayNarration}
            onNarratorTogglePause={togglePause}
            onNarratorStop={stop}
            onGoHome={goHome}
            onGoStoryBack={goStoryBack}
            onGoStoryForward={goStoryForward}
            canGoStoryBack={canGoStoryBack}
            canGoStoryForward={canGoStoryForward}
            storyNavDisabled={loading}
            playAgainLoading={loading}
            playAgainCaption={playAgainCaption}
            onPlayAgain={playAgain}
            illustrationUrl={illustrationUrl}
            illustrationStatus={illustrationStatus}
            illustrationDisableCode={illustrationDisableCode}
          />
        )}
      </main>
    </div>
  )
}
