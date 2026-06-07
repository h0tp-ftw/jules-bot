export function splitMessage(text: string, limit: number = 2000): string[] {
  if (text.length <= limit) return [text];
  const result: string[] = [];
  let current = text;
  while (current.length > limit) {
    let splitIndex = current.lastIndexOf('\n', limit);
    if (splitIndex === -1) splitIndex = limit; // If no newline is found, hard split
    result.push(current.slice(0, splitIndex));
    current = current.slice(splitIndex).trimStart();
  }
  if (current) result.push(current);
  return result;
}
