import { hashPassword, verifyPassword, httpError } from './security.js';
import { transaction } from './database.js';

const string = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const currentPassword = string(128, 1);
const email = { ...string(254, 3), pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' };
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });

export function registerAccounts(app, { db, authenticate, membership, loginResult, cleanupUploads, rateLimit, adminAccess }) {
  const auth = { preHandler: async req => authenticate(req), config: { rateLimit: rateLimit === false ? false : { max: 10, timeWindow: '1 minute' } } };
  const lastAdmin = adminAccess.lastAdmin;
  const owned = id => db.prepare(`SELECT s.id,s.name,
    (SELECT COUNT(*) FROM items i WHERE i.shelf_id=s.id) AS assetCount,
    (SELECT COUNT(*) FROM memberships n WHERE n.shelf_id=s.id) AS memberCount
    FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? AND m.role='owner' ORDER BY s.created_at`).all(id);
  const activeUploads = id => db.prepare("SELECT COUNT(*) n FROM upload_sessions WHERE user_id=? AND (state='processing' OR (state='uploading' AND expires_at>?))").get(id, Date.now()).n;
  async function reauthenticate(req) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!user || !(await verifyPassword(req.body.currentPassword, user.password_hash))) throw httpError(403, '現在のパスワードが違います。');
    authenticate(req); // Do not let an in-flight password check revive a revoked session.
    const latest = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!latest || latest.password_hash !== user.password_hash || latest.email !== user.email || latest.name !== user.name) throw httpError(409, 'アカウント情報が変更されました。画面を開き直してください。');
    return user;
  }
  app.get('/api/v1/account', auth, async req => ({
    user: req.user, ownedShelves: owned(req.user.id), activeUploads: activeUploads(req.user.id), lastServerAdmin: lastAdmin(req.user.id)
  }));
  app.patch('/api/v1/account', { ...auth, schema: { body: object({ currentPassword, name: string(80), email, newPassword: string(128, 12) }, ['currentPassword']) } }, async req => {
    const user = await reauthenticate(req);
    const name = (req.body.name ?? user.name).trim(), normalizedEmail = (req.body.email ?? user.email).trim().toLowerCase();
    if (!name) throw httpError(400, '表示名を入力してください。');
    const passwordHash = req.body.newPassword ? await hashPassword(req.body.newPassword) : user.password_hash;
    authenticate(req);
    return transaction(db, () => {
      const latest = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
      if (!latest || latest.password_hash !== user.password_hash || latest.email !== user.email || latest.name !== user.name) throw httpError(409, 'アカウント情報が変更されました。画面を開き直してください。');
      if (db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(normalizedEmail, user.id)) throw httpError(409, 'このメールアドレスは登録済みです。');
      db.prepare('UPDATE users SET name=?,email=?,password_hash=? WHERE id=?').run(name, normalizedEmail, passwordHash, user.id);
      // Rotate the current session too: all old tickets and sessions become invalid.
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      return loginResult({ id: user.id, name, email: normalizedEmail });
    });
  });
  app.delete('/api/v1/account', { ...auth, schema: { body: object({ currentPassword, confirmEmail: email }, ['currentPassword', 'confirmEmail']) } }, async (req, reply) => {
    const user = await reauthenticate(req);
    if (req.body.confirmEmail.trim().toLowerCase() !== user.email) throw httpError(400, '確認用メールアドレスが一致しません。');
    const uploads = transaction(db, () => {
      if (lastAdmin(user.id)) throw httpError(409, '最後のサーバー管理者は削除できません。先にサーバー管理メニューで別の管理者を指定してください。');
      const shelves = owned(user.id);
      if (shelves.some(shelf => shelf.assetCount > 0 || shelf.memberCount > 1)) throw httpError(409, '管理している本棚があります。先に管理を引き継ぐか、自分だけの本棚のアセットを削除してください。');
      if (activeUploads(user.id)) throw httpError(409, 'アップロード中です。完了またはキャンセルしてから削除してください。');
      const uploads = db.prepare('SELECT id FROM upload_sessions WHERE user_id=?').all(user.id).map(row => row.id);
      db.prepare('DELETE FROM analytics_views WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM upload_sessions WHERE user_id=?').run(user.id);
      for (const shelf of shelves) db.prepare('DELETE FROM shelves WHERE id=?').run(shelf.id);
      db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      return uploads;
    });
    await cleanupUploads(uploads);
    return reply.code(204).send();
  });
  app.put('/api/v1/shelves/:id/owner', { ...auth, schema: { body: object({ currentPassword, userId: string(36, 36) }, ['currentPassword', 'userId']) } }, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner']);
    await reauthenticate(req);
    transaction(db, () => {
      membership(req.params.id, req.user.id, ['owner']);
      if (req.body.userId === req.user.id) throw httpError(400, '別のメンバーを指定してください。');
      membership(req.params.id, req.body.userId);
      db.prepare("UPDATE memberships SET role='editor' WHERE shelf_id=? AND user_id=?").run(req.params.id, req.user.id);
      db.prepare("UPDATE memberships SET role='owner' WHERE shelf_id=? AND user_id=?").run(req.params.id, req.body.userId);
    });
    return reply.code(204).send();
  });
}
