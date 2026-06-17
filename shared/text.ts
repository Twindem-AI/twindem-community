// Shared terminal-text helpers used by both the renderer (display) and the main process (usage
// volume estimation). Regexes are hoisted to module scope: stripAnsi runs on EVERY pty chunk
// (dozens/sec while an agent streams); constructing them per call was measurable churn.
const ANSI_ESC = String.fromCharCode(27);
const ANSI_BEL = String.fromCharCode(7);
const ANSI_OSC_BEL_PATTERN = new RegExp(`${ANSI_ESC}\\][\\s\\S]*?${ANSI_BEL}`, "g");
const ANSI_OSC_ST_PATTERN = new RegExp(`${ANSI_ESC}\\][\\s\\S]*?${ANSI_ESC}\\\\`, "g");
const ANSI_CSI_PATTERN = new RegExp(`${ANSI_ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export function stripAnsi(value: string): string {
  return value.replace(ANSI_OSC_BEL_PATTERN, "").replace(ANSI_OSC_ST_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
}

export function normalizeTerminalVolumeText(value: string): string {
  const stripped = stripAnsi(value)
    .replace(/\r+/g, "\n")
    .replace(/[\u2800-\u28ff⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+/g, "")
    .replace(/[│╭╮╰╯─═┌┐└┘├┤┬┴┼]+/g, " ");
  const lines = stripped
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^(esc|ctrl|enter|shift|tab)\b/i.test(line))
    .filter((line) => !/^[-_=\s]{6,}$/.test(line));
  const compacted: string[] = [];
  let previous = "";
  let repeatCount = 0;
  for (const line of lines) {
    if (line === previous) {
      repeatCount += 1;
      if (repeatCount <= 1) compacted.push(line);
      continue;
    }
    previous = line;
    repeatCount = 0;
    compacted.push(line);
  }
  return compacted.join("\n");
}

// Rough chars/4 VOLUME estimate. The raw PTY stream contains TUI redraws and spinner frames even
// after ANSI stripping, so this deliberately measures "terminal context volume" — it must never
// be presented as billed tokens.
export function estimateTokens(text: string): number {
  const trimmed = normalizeTerminalVolumeText(text).trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}
