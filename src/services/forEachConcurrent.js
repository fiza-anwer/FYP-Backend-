export async function forEachConcurrent(items, concurrency, callback) {
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        await callback(items[index], index);
      }
    })
  );
}
