import { ArrowRight } from 'lucide-react';
import './landing.css';

export function LandingPage() {
  return (
    <main className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-copy">
        <p className="landing-kicker" lang="en">
          Ambient workflows
        </p>
        <h1 id="landing-title">
          実験データから、
          <br />
          解析レポートへ。
        </h1>
        <p className="landing-description">
          実験データを投入すると、起動中の Codex や Claude Code
          のワーカーがジョブを受け取り、プロジェクトで定めた工程に沿って解析します。
          各工程の実行ログと HTML・PowerPoint のレポートを、ジョブごとに確認できます。
        </p>
        <a className="landing-projects" href="/projects">
          プロジェクト一覧へ
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      </div>
      <img
        className="landing-photo"
        src="/images/railflow-lab.webp"
        alt="材料分析を行う研究室の実験装置"
        width={1536}
        height={1024}
        fetchPriority="high"
      />
    </main>
  );
}
