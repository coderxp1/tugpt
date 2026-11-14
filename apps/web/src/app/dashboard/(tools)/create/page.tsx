import type { Metadata } from 'next';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Create · TuGPT' };

export default function CreatePage() {
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>Create</p>
        <h1>Images and video, generated privately</h1>
        <p>Generation runs on TuGPT&rsquo;s own EU GPU. Your prompts and results are not sent to third-party image services.</p>
      </header>
      <ul className={s.grid}>
        <li className={s.card}>
          <div className={s.cardHead}><span className={s.logo} aria-hidden="true">I</span><div><h2>Image generation</h2><p>Product shots, social visuals and concept art from a text prompt.</p></div><span className={`${s.badge} ${s.off}`}>Not enabled yet</span></div>
          <p className={s.next}>Being enabled for your workspace. It will appear here, and in Chat, when it is ready.</p>
        </li>
        <li className={s.card}>
          <div className={s.cardHead}><span className={s.logo} aria-hidden="true">V</span><div><h2>Video generation</h2><p>Short clips from a prompt or an image.</p></div><span className={`${s.badge} ${s.off}`}>Not available yet</span></div>
          <p className={s.next}>Planned after image generation.</p>
        </li>
      </ul>
    </div>
  );
}
