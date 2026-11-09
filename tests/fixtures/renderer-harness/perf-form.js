async ({}) => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); return !!fn(); };
  await showSync(); await tick();
  const email = document.getElementById('syncEmail'), pass = document.getElementById('syncPassword');
  email.value = 'typed@example.test'; pass.value = 'a-long-password'; pass.focus();
  try { pass.setSelectionRange(3, 3); } catch (_) {}
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) { window.__fireProgress({ pending: 200 - i, sending: 1 }); await tick(); }
  const elapsed = performance.now() - t0;
  const now = document.getElementById('syncEmail'), nowPass = document.getElementById('syncPassword');
  return { progress200_ms: Math.round(elapsed * 10) / 10,
    same_input_node: now === email && nowPass === pass, email_kept: now?.value === 'typed@example.test',
    password_kept: nowPass?.value === 'a-long-password', focus_kept: document.activeElement === nowPass,
    caret_kept: nowPass?.selectionStart === 3 };
}
