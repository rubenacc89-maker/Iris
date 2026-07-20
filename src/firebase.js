const { initializeApp } = require('firebase/app')
const { getAuth, signInWithCredential, GoogleAuthProvider, signOut } = require('firebase/auth')

const firebaseConfig = {
  apiKey:            'AIzaSyDFWZT-bBR86iPPrlW_gJugjiY4Fdkmm9Y',
  authDomain:        'iris-overlay-91909.firebaseapp.com',
  projectId:         'iris-overlay-91909',
  storageBucket:     'iris-overlay-91909.firebasestorage.app',
  messagingSenderId: '444401643532',
  appId:             '1:444401643532:web:c40725d8d376b596667e29'
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
