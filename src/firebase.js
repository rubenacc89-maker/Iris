const { initializeApp } = require('firebase/app')
const { getAuth, signInWithCredential, GoogleAuthProvider, signOut } = require('firebase/auth')

const firebaseConfig = {
  apiKey:            process.env.FIREBASE_API_KEY,
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.FIREBASE_PROJECT_ID,
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.FIREBASE_APP_ID
}

let _app = null
let _auth = null

function getFirebase() {
  if (!_app) {
    _app  = initializeApp(firebaseConfig)
    _auth = getAuth(_app)
  }
  return _auth
}

async function signInWithGoogleIdToken(idToken) {
  const auth       = getFirebase()
  const credential = GoogleAuthProvider.credential(idToken)
  const result     = await signInWithCredential(auth, credential)
  const u          = result.user
  return {
    id:       u.uid,
    email:    u.email,
    name:     u.displayName,
    photoURL: u.photoURL
  }
}

async function firebaseLogout() {
  const auth = getFirebase()
  await signOut(auth)
}

module.exports = { signInWithGoogleIdToken, firebaseLogout }
