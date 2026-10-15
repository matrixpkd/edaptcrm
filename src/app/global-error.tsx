"use client";
import { ErrorPanel } from "@/components/shell/error-panel";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#f6f6f4", padding: 24 }}>
        <ErrorPanel error={error} reset={reset} />
      </body>
    </html>
  );
}
