# Tachyon Cloud App build Action

Tachyon が受け付けた Cloud App のビルドを、利用者の GitHub Actions runner で実行する。初期版は **Lambda ZIP のみ**。ビルド後の Lambda デプロイは Tachyon が行う。

## 導入

1. このディレクトリの `action.yml` と `run.mjs` を公開 repo `quantum-box/tachyon-ops-action` の `cloud-app-build/` に配布する（現時点では未配布）。`workflow.example.yml` を対象 repo の `.github/workflows/tachyon-build.yml` に配置し、`REPLACE_WITH_COMMIT_SHA` を配布先のレビュー済み commit SHA に置き換える。`tachyon-apps` は private のため、公開 sample の workflow から直接参照しない。
2. protected workflow の `api-url` を Tachyon API の HTTPS origin に固定する。dispatch input から API URL、コマンド、secret を受け取らない。必要な言語・toolchain・Node version は workflow で事前セットアップする。runner は Linux、Node 20 以上、Git、Bash、zip が必要。
3. operator が API に次の設定を渡す。GitHub App には対象 repository の Contents read / Actions write を与える。repository の作成・設定変更は governance Terraform 経由で行う。

```json
{
  "app_REPLACE_WITH_APP_ID": {
    "repository": "OWNER/REPOSITORY",
    "repository_id": "123456789",
    "installation_id": "987654321",
    "workflow": "tachyon-build.yml",
    "workflow_ref": "refs/heads/main"
  }
}
```

この JSON が `COMPUTE_GITHUB_ACTIONS_BINDINGS`、private S3 bucket 名が `COMPUTE_GITHUB_ACTIONS_BUCKET`。bucket は対象 Lambda と同じ AWS region に置き、API の AWS SDK もその region を使う。API role に `github-builds/*` の GetObject / PutObject を許可し、public access を全て block する。build ticket の保存値は SSE-S3 暗号化される。`github-builds/tickets/` prefix は 1 日で失効する lifecycle を設定する。**`github-builds/artifacts/` prefix の ZIP は Lambda の再デプロイで使うため、ticket と同じ短期削除 rule に含めない。** ticket は機密の build env を含むので、bucket の閲覧権限を利用者に与えない。

4. Cloud App のビルド設定に `runnerBackend: github_actions` を指定する。`command` と `outputDirectory` を明示する。`outputDirectory` はビルド root 内のディレクトリ、または `.zip` ファイルを指定する。

```yaml
spec:
  deploymentTarget: lambda
  build:
    runnerBackend: github_actions
    command: npm run build
    outputDirectory: dist
```

通常の `tachyon.yaml` に IaC 実行が設定されている場合、初期版は submit 前に拒否する。既存の CLI に含まれる manifest schema は `github_actions` 未対応のため、この初期版では API の build request の `runner_backend: github_actions` または server が読み込む repository 内の manifest を使う。最初の検証では API / app settings から build command と output directory を設定し、IaC ステップを持たない Lambda app を使う。

## 契約

- `workflow_dispatch` input は Tachyon の `build_id` のみ。ソース SHA と build command は OIDC 認証後に取得する。checkout は branch 名ではなく確定 SHA を使用する。
- `id-token: write` と `contents: read` が必要。OIDC audience は `tachyon-api/cloud-app-build`。repo ID / workflow ref / run ID / event / attempt を検証する。Tachyon の長期 API key は不要。
- ZIP は署名付き URL への create-only PUT。別 build の成果物や、後から上書きした ZIP を採用しない。最大 512 MiB。S3 側では受信バイト数を HEAD で確認する。
- GHA runner の分数を Tachyon の build-minute 課金に加算しない。GitHub の利用料と通常の Lambda / storage 利用料は別。
- 成功・失敗は durable receipt と既存 CompleteBuild へ反映する。通知が途絶えた場合は status polling で GHA の失敗・キャンセルを確認する。Tachyon のキャンセルは GHA run の cancel API へ連携する。
- GHA 画面での rerun は拒否する。再試行は Tachyon から新しい build を作る。dispatch の応答が失われた run は機密 workload を取得できない。
- Cloudflare、container image、IaC、D1、supplemental artifact は未対応。異なる target へ暗黙変換しない。
- Cloud App のログ API は ticket の保持期間中、対応する GHA run へのリンクを返す。GHA ログ本文のミラーリングは行わない。ticket の失効後は GitHub の実行履歴を参照する。

## 検証

最初の対象は公開 [tachyon-api-server-template](https://github.com/quantum-box/tachyon-api-server-template)（repository ID: `1188397578`）。Node 22 の Lambda 用 sample で、以下の build 設定を使う。app ID と GitHub App installation ID は対象環境から解決する。既存 sample の稼働 app を暗黙に変更しない。

```yaml
spec:
  deploymentTarget: lambda
  build:
    runnerBackend: github_actions
    installCommand: npm ci
    command: npm run build
    outputDirectory: lambda.zip
```

allowlist の `repository` は `quantum-box/tachyon-api-server-template`、`repository_id` は `1188397578`、`workflow` は `tachyon-build.yml`、`workflow_ref` は `refs/heads/main`。この sample は `tachyon.yaml` を持たないため、初回は app の build settings / API から同じ値を指定すると build-time IaC を有効にせず試せる。Lambda runtime は Node.js 22.x、handler は `index.handler` を設定する。

```sh
node --test .github/actions/cloud-app-build/run.test.mjs
```

実環境では、1 app で開始・成功・Lambda deploy を確認した後、キャンセルと別 run / rerun の OIDC 拒否を確認する。既定 runner は Kata のまま。戻す場合は app の runner を変更し、進行中 GHA build が終了するまで API の GHA 設定を維持する。
