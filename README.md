# パンバトル 3D 試遊版

iPhoneを縦に持ち、軽く振って攻撃、左右に傾けて回避するCPUとの1対1ゲームです。食パン・フランスパン・クロワッサンから選べます。

試遊URL: https://sryusukeh-hue.github.io/panbattle-play/

Safariで開き、「食卓で勝負する」→「動きの利用を許可する」→構え位置の調整→パン選択→練習へ進みます。証明書の追加やアプリのインストールは不要です。1試合60秒以内。結果で回避・反撃の成績を同じ条件の自己ベストと比較できます。

**iPhoneでの操作感と性能を確認中の試遊版です。** 最初は軽い動きで練習してください。センサーを利用できない場合は「補助操作で遊ぶ」からタッチ操作を選べます。

## 開発・検証

Node.js 20.19以上を使用します。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run check:size
npm run test:browser:install
npm run test:e2e
npm run dev -- --host 127.0.0.1 --port 4183
```

ローカルURLは `http://127.0.0.1:4183/panbattle-play/`。キーボード操作はSpace/Zで攻撃、矢印/A Dで横移動、Escapeで一時停止です。

GitHub Actionsで検証後、`dist-3d/`をPagesへ公開します。配布上限は5 MiB。検証用状態制御は開発時の`?test=1`のみで、配布物には入りません。

このリポジトリは3D試遊版の公開用です。制作元のBlenderファイルやLAN接続用の証明書・秘密鍵は含めていません。パンのモデルは制作者提供のGLBを使用し、読み込んだ複製に動きを付けています。保存は端末内の`panbattle.3d.v1`を使用します。
