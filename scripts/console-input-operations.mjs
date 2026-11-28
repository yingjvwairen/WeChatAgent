const fault = (message, status = 409) => Object.assign(Error(message), { status });

export function createInputOperationsApi({ root, account, assertStopped, operations }) {
  const backend = async () => operations ?? (await import('./desktop-sender/operations.mjs'));
  async function snapshot() {
    const accountRef = account();
    const result = await (await backend()).snapshotOperations({ root, accountRef });
    if (account() !== accountRef) throw fault('微信账号已变化，请刷新操作记录。');
    return { ...result, account: accountRef };
  }
  async function recover(body) {
    if (
      !body ||
      Object.keys(body).some(
        key =>
          ![
            'account',
            'id',
            'revision',
            'acknowledgeDraftCleared',
            'acknowledgeRecordingEnded',
            'acknowledgeOutcomeReviewed',
          ].includes(key),
      ) ||
      typeof body.id !== 'string' ||
      !body.id ||
      body.id.length > 200 ||
      !['string', 'number'].includes(typeof body.revision) ||
      ['acknowledgeDraftCleared', 'acknowledgeRecordingEnded', 'acknowledgeOutcomeReviewed'].some(
        key => body[key] !== undefined && typeof body[key] !== 'boolean',
      )
    )
      throw fault('请选择需要恢复的操作记录。', 400);
    const accountRef = account();
    if (body.account !== accountRef) throw fault('微信账号已变化，请刷新操作记录。');
    const service = await backend();
    await service.recoverOperation({
      root,
      accountRef,
      id: body.id,
      revision: body.revision,
      acknowledgeDraftCleared: body.acknowledgeDraftCleared === true,
      acknowledgeRecordingEnded: body.acknowledgeRecordingEnded === true,
      acknowledgeOutcomeReviewed: body.acknowledgeOutcomeReviewed === true,
      assertStopped: () => {
        if (account() !== accountRef) throw fault('微信账号已变化。');
        return assertStopped();
      },
    });
    return snapshot();
  }
  return { snapshot, recover };
}
