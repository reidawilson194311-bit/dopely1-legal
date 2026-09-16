/**
 * A stage that tried to do work and failed at every single item is a broken
 * stage, not an idle one - but both return an empty list. Without this
 * distinction an unattended cron reports success forever while producing
 * nothing, which is the one failure mode a machine with no human in the loop
 * cannot afford.
 *
 * Call at the end of a skill, after its results have been written to the
 * store, so a partial run keeps what it earned.
 */
export function reportBatch(log, { attempted, succeeded, errors }) {
  if (!errors.length) return;

  if (succeeded === 0) {
    throw new Error(
      `${errors.length} of ${attempted} item(s) errored and none succeeded` +
        ` - first error: ${errors[0]}`,
    );
  }
  log.warn(`${errors.length} of ${attempted} item(s) failed`, errors[0]);
}

export default reportBatch;
