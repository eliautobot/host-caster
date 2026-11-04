// An AbortSignal for "the app stopped waiting": it fires when the connection closes before the answer was sent (the
// app gave up on a slow voice line, the listener pressed Next, a phone lost its network). Work done for that request
// (an AI or voice call to a provider) stops then, instead of holding the user's slot for as long as the provider takes.

/** @param {import('fastify').FastifyReply} reply */
export function whenGone(reply) {
  const ctl = new AbortController();
  const res = reply.raw;
  const onClose = () => {
    if (!res.writableFinished) ctl.abort(new Error('The app stopped waiting'));
  };
  res.once('close', onClose);
  return ctl.signal;
}
