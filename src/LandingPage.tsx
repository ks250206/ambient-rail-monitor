import { ArrowRight } from 'lucide-react';
import { useI18n } from './i18n.ts';
import './landing.css';

export function LandingPage() {
  const { pick } = useI18n();
  return (
    <main className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-copy">
        <p className="landing-kicker" lang="en">
          Ambient workflows
        </p>
        <h1 id="landing-title">
          {pick('実験データから、', 'From lab data,')}
          <br />
          {pick('解析レポートへ。', 'to verified reports.')}
        </h1>
        <p className="landing-description">
          {pick(
            '実験データを投入すると、起動中の Codex や Claude Code のワーカーがジョブを受け取り、プロジェクトで定めた工程に沿って解析します。各工程の実行ログと HTML・PowerPoint のレポートを、ジョブごとに確認できます。',
            'Submit experimental datasets and let running Codex or Claude Code pull workers execute your project workflow step by step. Inspect per-stage logs, gates, provenance, and generated HTML / PowerPoint reports for every run.',
          )}
        </p>
        <a className="landing-projects" href="/projects">
          {pick('プロジェクト一覧へ', 'Open projects')}
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      </div>
      <img
        className="landing-photo"
        src="/images/railflow-lab.webp"
        alt={pick(
          '材料分析を行う研究室の実験装置',
          'Laboratory experimental instrumentation for materials analysis',
        )}
        width={1536}
        height={1024}
        fetchPriority="high"
      />
    </main>
  );
}
