import { useEffect, useState } from 'react'
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth'
import { getFirebaseAuth } from '../lib/firebase'
import styles from '../styles/home.module.css'

const authErrorMessages = {
  'auth/account-exists-with-different-credential':
    'An account already exists with this email. Sign in using its original method.',
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/invalid-credential': 'The email or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/network-request-failed':
    'Unable to reach the authentication service. Check your connection and try again.',
  'auth/operation-not-allowed':
    'This sign-in method is not enabled for this Firebase project.',
  'auth/popup-blocked': 'Allow pop-ups for this site and try again.',
  'auth/popup-closed-by-user': 'The Google sign-in window was closed.',
  'auth/weak-password': 'Choose a password with at least 6 characters.',
}

function getAuthErrorMessage(error) {
  return authErrorMessages[error?.code] ?? 'Authentication failed. Please try again.'
}

function Home() {
  const [user, setUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [configurationError, setConfigurationError] = useState('')
  const [mode, setMode] = useState('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    let unsubscribe

    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
        setUser(currentUser)
        setAuthReady(true)
      })
    } catch (error) {
      setConfigurationError(error.message)
      setAuthReady(true)
    }

    return () => unsubscribe?.()
  }, [])

  async function handleEmailSubmit(event) {
    event.preventDefault()
    setIsBusy(true)
    setErrorMessage('')

    try {
      const auth = getFirebaseAuth()
      if (mode === 'register') {
        await createUserWithEmailAndPassword(auth, email, password)
      } else {
        await signInWithEmailAndPassword(auth, email, password)
      }
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleGoogleSignIn() {
    setIsBusy(true)
    setErrorMessage('')

    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      await signInWithPopup(getFirebaseAuth(), provider)
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  async function handleSignOut() {
    setIsBusy(true)
    setErrorMessage('')

    try {
      await signOut(getFirebaseAuth())
    } catch (error) {
      setErrorMessage(getAuthErrorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  if (!authReady) {
    return (
      <main className={styles.page}>
        <p role="status">Loading authentication…</p>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="page-title">
        <p className={styles.eyebrow}>Welcome</p>
        <h1 id="page-title">
          {user
            ? 'You’re signed in'
            : mode === 'register'
              ? 'Create your account'
              : 'Sign in to your account'}
        </h1>

        {configurationError ? (
          <p className={styles.error} role="alert">
            Authentication is not configured. {configurationError}
          </p>
        ) : user ? (
          <div className={styles.signedIn}>
            <p>Signed in as</p>
            <strong>{user.email ?? user.displayName ?? 'Google account'}</strong>
            <button
              className={styles.primaryButton}
              disabled={isBusy}
              onClick={handleSignOut}
              type="button"
            >
              {isBusy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        ) : (
          <>
            <p className={styles.description}>
              Continue with your email and password or an existing Google
              account.
            </p>

            <button
              className={styles.googleButton}
              disabled={isBusy}
              onClick={handleGoogleSignIn}
              type="button"
            >
              Continue with Google
            </button>

            <div className={styles.divider}>
              <span>or use your email</span>
            </div>

            <form className={styles.form} onSubmit={handleEmailSubmit}>
              <label htmlFor="email">Email</label>
              <input
                autoComplete="email"
                disabled={isBusy}
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />

              <label htmlFor="password">Password</label>
              <input
                autoComplete={
                  mode === 'register' ? 'new-password' : 'current-password'
                }
                disabled={isBusy}
                id="password"
                minLength={6}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />

              {errorMessage && (
                <p className={styles.error} role="alert">
                  {errorMessage}
                </p>
              )}

              <button
                className={styles.primaryButton}
                disabled={isBusy || Boolean(configurationError)}
                type="submit"
              >
                {isBusy
                  ? 'Please wait…'
                  : mode === 'register'
                    ? 'Create account'
                    : 'Sign in'}
              </button>
            </form>

            <p className={styles.switchMode}>
              {mode === 'register'
                ? 'Already have an account?'
                : 'New here?'}{' '}
              <button
                disabled={isBusy}
                onClick={() => {
                  setMode(mode === 'register' ? 'signIn' : 'register')
                  setErrorMessage('')
                }}
                type="button"
              >
                {mode === 'register' ? 'Sign in' : 'Create an account'}
              </button>
            </p>
          </>
        )}

        {errorMessage && user && (
          <p className={styles.error} role="alert">
            {errorMessage}
          </p>
        )}
      </section>
    </main>
  )
}

export default Home