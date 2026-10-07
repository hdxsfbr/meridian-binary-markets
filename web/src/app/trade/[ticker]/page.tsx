export default async function TradePage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  return (
    <div className="px-6 py-4">
      <h1 className="text-2xl font-semibold">{ticker}</h1>
    </div>
  );
}
