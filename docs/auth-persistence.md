# ログイン状態の保持

ログイン／新規登録時の「ログイン状態を保持する」は初期ONです。ブラウザーやアプリを閉じても、元のログインから最長7日間は復元できます。復元操作では有効期限を延長しません。共用端末ではOFFにしてください。パスワードは保存しません。

## Web

`__Secure-mirea_session` Cookieに既存のセッショントークンを保存します。Secure、HttpOnly、SameSite=Strict、Path=/api/v1、元の失効日時を設定し、Domainは設定しません。HTTPSが必要です。Cookieが拒否された場合は一時ログインへフォールバックし、保持できなかった旨を表示します。

`GET /api/v1/auth/remember` だけがCookieから復元し、DB上の期限・失効・アカウント有効性を確認します。通常のAPIは従来どおりBearer必須で、Cookieだけでは変更操作やメディア取得を認可しません。復元応答はno-storeで、cross-site要求は拒否します。POSTによる保持はBearer認証必須、DELETEによる解除はCookieと本文トークンの一致が必要です。CORSの資格情報共有は有効化しません。

## Android

ログイントークン・期限・最小限のユーザー情報だけを専用プラグインへ渡し、Android Keystoreで生成した非エクスポート鍵によるAES-256-GCMで暗号化してアプリ専用SharedPreferencesへ保存します。ランダムIVと認証タグを使用し、HTTPSサーバーoriginをAADとして別サーバーへの流用を防ぎます。保存領域もorigin単位で分離します。バックアップは従来どおり無効で、新しい権限は要求しません。

暗号文や鍵が失われた場合は再ログインしてください。再インストールやアプリデータ消去後の保持は保証しません。一般的なブラウザーのlocalStorageには認証情報を保存しません。

## 復元と解除

- 保持OFFはsessionStorageによる一時ログインです。既存の一時セッションはオンライン検証後に安全な保存先へ移行します。
- 起動時はオンラインで現在のアカウントを検証してから本棚を表示します。通信エラーでは保存情報を消さず、再接続画面を表示します。
- ログアウト・期限切れ・停止・サーバー側のセッション失効で復元できなくなります。アカウント情報変更時は全旧セッションを失効し、現在の保持選択を維持して新トークンへ切り替えます。
- 同時進行する古い検証・401応答で、新しいログインやサーバー選択を上書きしないようにします。
- 共有端末のOSアカウントやブラウザープロファイルへアクセスできる人は、保持されたログインを使用し得ます。不要になったらログアウトしてください。

## 検証範囲

サーバーのCookie属性・復元・失効・停止・期限・通常APIのBearer必須、JS保存先の分離・一時保存・通信障害・保存/解除順序、JVMの暗号化ラウンドトリップ・ランダムIV・改ざん/AAD拒否を自動テストします。Android Keystore自体の永続性はAndroid実機での追加確認が必要です。

参照: [MDN Cookie属性](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[Android KeyGenParameterSpec](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec)。
