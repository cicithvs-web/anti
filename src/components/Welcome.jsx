import RippleButton from './RippleButton.jsx';
function greeting() {
  const h = new Date().getHours();
  if (h < 11) return 'Selamat pagi';
  if (h < 15) return 'Selamat siang';
  if (h < 19) return 'Selamat sore';
  return 'Selamat malam';
}

export default function Welcome({ name }) {
  return (
    <div className="welcome">
      <img className="welcome-logo" src="/logo.png" alt="AntiGPT" width="58" height="58" />
      <h1>{greeting()}, {name}</h1>
      <p>Mau nanya apa hari ini?</p>
    </div>
  );
}
