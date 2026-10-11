interface DisposableRuntime {
  session: { abort(): Promise<void>; dispose(): void };
  dispose(): Promise<void>;
}

/** SDK runtime.dispose 不负责等待 abort；shutdown 失败仍需释放 session 资源。 */
export async function disposeRuntime(runtime: DisposableRuntime): Promise<void> {
  const errors: unknown[] = [];
  try {
    await runtime.session.abort();
  } catch (error) {
    errors.push(error);
  }
  try {
    await runtime.dispose();
  } catch (error) {
    errors.push(error);
    try {
      runtime.session.dispose();
    } catch (disposeError) {
      errors.push(disposeError);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed');
}
