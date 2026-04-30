import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Tone = "good" | "warn" | "idle";

const toneClass: Record<Tone, string> = {
  good: "border-teal/25 bg-teal/10 text-teal shadow-sm shadow-teal/10",
  warn: "border-rust/25 bg-rust/10 text-rust shadow-sm shadow-rust/10",
  idle: "border-line bg-white/70 text-muted",
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
    <Badge className={`gap-1.5 px-2.5 py-1 ${toneClass[tone]}`} variant="outline">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </Badge>
  );
}

