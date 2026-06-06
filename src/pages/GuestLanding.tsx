import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './guest-landing.css'

const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

export function GuestLanding() {
  const handleGoogleSignIn = useCallback(async () => {
    if (!supabase || !isAuthConfigured) {
      window.alert('認証設定が未完了です。')
      return
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })

    if (error) {
      window.alert(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    window.alert('認証URLの取得に失敗しました。')
  }, [])

  return (
    <div className="guest-home">
      <header className="guest-home__header">
        <Link className="guest-home__brand" to="/">
          <img src="/favicon.png" alt="" aria-hidden="true" />
          <span>MeltPlus</span>
        </Link>
      </header>

      <main className="guest-home__main">
        <section className="guest-home__hero">
          <div className="guest-home__copy">
            <p className="guest-home__kicker">MeltAIの派生モデルが登場</p>
            <h1>動画生成の最前線を体感しよう。</h1>
            <p className="guest-home__lead">
              参照画像と短いテキストから、SNS向けの高品質動画をすばやく生成できます。まずはログインしてすぐ開始。
            </p>

            <div className="guest-home__media-row">
              <figure className="guest-home__media-card" aria-label="キービジュアル">
                <img className="guest-home__media-image" src="/media/meltplus-hero.png" alt="MeltPlus banner" loading="eager" />
              </figure>

              <div className="guest-home__media-card guest-home__media-card--video">
                <video
                  className="guest-home__sample-video"
                  src="/media/meltplus-sample-20.mp4"
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="auto"
                  poster="/media/meltplus-hero.png"
                  aria-label="サンプル動画"
                />
              </div>
            </div>

            <div className="guest-home__actions">
              <button type="button" className="guest-home__login-btn" onClick={handleGoogleSignIn}>
                サインアップ / ログイン
              </button>
            </div>

            <ul className="guest-home__points">
              <li>画像アップロードで簡単スタート</li>
              <li>6秒動画を簡単に生成</li>
              <li>ブラウザだけで完結</li>
              <li>MeltAIをベースにした独自モデル搭載</li>
              <li>動画に合わせた効果音生成に対応</li>
              <li>無料登録で5回生成無料</li>
              <li>毎日3回分のボーナス提供</li>
            </ul>

            <section className="guest-home__capabilities" aria-labelledby="capabilities-title">
              <h2 id="capabilities-title">MeltPlusでできること</h2>
              <div className="guest-home__capability-grid">
                <article className="guest-home__capability-card">
                  <h3>画像から動画が簡単に</h3>
                  <p>1枚の画像に呪文を加えるだけで、動きのある6秒動画をすぐ作成できます。</p>
                </article>
                <article className="guest-home__capability-card">
                  <h3>6秒動画をすぐに生成</h3>
                  <p>短尺で使いやすい6秒固定。SNS投稿や広告クリエイティブの試作にも最適です。</p>
                </article>
                <article className="guest-home__capability-card">
                  <h3>Soundで効果音付き動画に</h3>
                  <p>動画と短い指示から、環境音や動作音を加えた音声付き動画を作成できます。</p>
                </article>
              </div>

              <div className="guest-home__fashion-block">
                <div className="guest-home__fashion-head">
                  <h3>着せ替えも簡単。新しいおしゃれな自分に出会える</h3>
                  <p>ファッションの確認やコーデ検討に使いやすく、雰囲気を変えた自分のイメージをすぐ試せます。</p>
                </div>
                <div className="guest-home__fashion-grid">
                  <figure className="guest-home__fashion-card">
                    <img src="/media/fashion-before.png" alt="元画像サンプル" loading="lazy" />
                    <figcaption>元画像</figcaption>
                  </figure>
                  <figure className="guest-home__fashion-card">
                    <img src="/media/fashion-after.png" alt="編集後サンプル" loading="lazy" />
                    <figcaption>編集後</figcaption>
                  </figure>
                </div>
              </div>

              <div className="guest-home__diff-block">
                <div className="guest-home__diff-head">
                  <h3>MeltAIとの違い</h3>
                  <p>MeltPlusはMeltAIの動画モデルをファインチューニングしたオリジナルモデルです。MeltAIよりも多種多様な動きを再現できるように最適化しています。</p>
                </div>
                <div className="guest-home__table-wrap">
                  <table className="guest-home__compare-table" aria-label="MeltAIとMeltPlusの比較表">
                    <thead>
                      <tr>
                        <th>比較項目</th>
                        <th>MeltAI</th>
                        <th>MeltPlus</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>モデル</td>
                        <td>標準動画モデル</td>
                        <td>ファインチューニング済みオリジナルモデル</td>
                      </tr>
                      <tr>
                        <td>動きの再現</td>
                        <td>基本的な動きに対応</td>
                        <td>多種多様な動きを再現できるように調整</td>
                      </tr>
                      <tr>
                        <td>動画の長さ</td>
                        <td>5秒または8秒</td>
                        <td>6秒のみ</td>
                      </tr>
                      <tr>
                        <td>生成時間</td>
                        <td>標準速度</td>
                        <td>MeltAIより約10〜20秒短縮</td>
                      </tr>
                      <tr>
                        <td>Sound</td>
                        <td>なし</td>
                        <td>動画に合わせた効果音生成に対応</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>

      <footer className="guest-home__footer">
        <nav className="guest-home__legal">
          <Link to="/terms">利用規約</Link>
          <Link to="/tokushoho">特商法</Link>
        </nav>
      </footer>
    </div>
  )
}
