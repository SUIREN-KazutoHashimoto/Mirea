import {randomUUID} from 'node:crypto';
import {hashPassword} from './security.js';
import {transaction} from './database.js';
export async function initializeDefaultAdmin(db){
  if(db.prepare('SELECT 1 FROM users LIMIT 1').get())return;
  const hash=await hashPassword('ChangeMe');
  transaction(db,()=>{if(db.prepare('SELECT 1 FROM users LIMIT 1').get())return;
    const id=randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,'admin@example.com','Administrator',hash,Date.now());
    db.prepare("INSERT INTO user_access(user_id,server_role) VALUES(?,'admin')").run(id);
    db.prepare('INSERT INTO bootstrap_accounts VALUES(?,?)').run(id,hash);
  });
}
export function defaultCredentialWarning(db,id){
  const row=db.prepare('SELECT u.email,u.password_hash,b.initial_hash FROM users u JOIN bootstrap_accounts b ON b.user_id=u.id WHERE u.id=?').get(id);
  return Boolean(row&&(row.email.toLowerCase()==='admin@example.com'||row.password_hash===row.initial_hash));
}
