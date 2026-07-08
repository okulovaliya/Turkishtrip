/*
  Firebase выдаёт этот блок в формате "модульного" SDK (import { initializeApp }...),
  но app.js в этом проекте использует более простой "compat" SDK (подключается через
  обычные <script> теги в index.html, без import/бандлера). Поэтому здесь оставлен
  только объект firebaseConfig — само подключение (firebase.initializeApp(...))
  app.js делает самостоятельно.
*/
const firebaseConfig = {
  apiKey: "AIzaSyCq9Zzpr6_CSKZ-dHYz2J2Sixy5Qe1Pe2I",
  authDomain: "turkish-trip-26.firebaseapp.com",
  databaseURL: "https://turkish-trip-26-default-rtdb.firebaseio.com",
  projectId: "turkish-trip-26",
  storageBucket: "turkish-trip-26.firebasestorage.app",
  messagingSenderId: "443292141172",
  appId: "1:443292141172:web:ad5a6dd86f28f9e3977321"
};