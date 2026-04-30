import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";

type Tone = "good" | "warn" | "idle";

const toneClass: Record<Tone, string> = {
  good: "border-teal/25 bg-teal/10 text-teal",
  warn: "border-rust/25 bg-rust/10 text-rust",
  idle: "border-line bg-panel text-muted",
};

export function StatusPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "warn" ? CircleAlert : CircleDashed;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass[tone]}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </span>
  );
}

