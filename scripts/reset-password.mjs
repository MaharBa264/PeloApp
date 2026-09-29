// Genera el SQL para restablecer la contraseña de un usuario (por ejemplo, si se perdió el único superadministrador).
// Uso:  NEW_PASSWORD='...' node scripts/reset-password.mjs persona@correo.com > reset.sql
// Luego: npx wrangler@4 d1 execute PeloApp-prod --remote --file reset.sql   (dev: PeloApp-dev --remote --env dev)
// No guarda nada por sí mismo y la contraseña nunca queda en el repositorio: borrá reset.sql después de usarlo.
import { passwordHash } from '../src/worker.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const password = process.env.NEW_PASSWORD || '';
if (!/^[^\s@'"\;]+@[^\s@'"\;]+\.[^\s@'"\;]+$/.test(email)) { console.error('Indicá el correo del usuario como primer argumento.'); process.exit(1); }
if (password.length < 12 || password.length > 128) { console.error('Definí NEW_PASSWORD con 12 a 128 caracteres.'); process.exit(1); }
const hash = await passwordHash(password);
const data = JSON.stringify({ email }).replaceAll("'", "''");
console.log(`UPDATE users SET password='${hash}', active=1 WHERE email='${email}';
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
INSERT INTO audit(id,actor,action,data,created_at) VALUES ('${crypto.randomUUID()}',NULL,'user.password_reset_cli','${data}','${new Date().toISOString()}');`);
