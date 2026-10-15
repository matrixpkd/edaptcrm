import Image from "next/image";

/** The centred card the signed-out pages share (sign in, set up, forgot password, reset). */
export function AuthCard({ subtitle, children, footer }: { subtitle: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Image src="/brand/edapt-logo.png" alt="Edapt" width={150} height={42} priority />
          <p className="text-center text-sm text-muted">{subtitle}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">{children}</div>
        {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}
