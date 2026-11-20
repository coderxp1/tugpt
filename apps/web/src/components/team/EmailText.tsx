import { Fragment } from 'react';

/** Renders an e-mail address with soft break points after "@" and dots, so narrow columns never break mid-word. */
export function EmailText({ value }: { value: string }) {
  const parts = value.split(/(?<=[@.])/);
  return <>{parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <wbr />}</Fragment>)}</>;
}
