
export function EmptyCell({ text }: { text: string }) {
  return <div className="tree-empty" style={{ padding: "28px 16px", textAlign: "center" }}>{text}</div>;
}
