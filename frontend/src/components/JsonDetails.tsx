type JsonDetailsProps = {
  title: string;
  value: unknown;
};

export function JsonDetails({ title, value }: JsonDetailsProps) {
  return (
    <details className="json-details">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
