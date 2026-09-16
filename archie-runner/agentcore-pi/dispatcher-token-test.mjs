// Per-turn dispatcher credential, runtime side. Pure, dependency-free. Run:
//
//   node agentcore-pi/dispatcher-token-test.mjs
//
import { applyDispatcherToken } from './dispatcher-token.mjs';

let ok = true;
const check = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && cond; };

{
  const env = {};
  const had = applyDispatcherToken({ dispatcherToken: 'v1.abc.def' }, env);
  check('sets DISPATCHER_SHARED_SECRET from the payload', env.DISPATCHER_SHARED_SECRET === 'v1.abc.def');
  check('reports that a token was present', had === true);
}

// THE ONE THAT MATTERS. A turn with no token must not inherit the previous turn's: the dispatcher
// deleted that token when its turn ended, so presenting it yields `revoked` — an ALARM reason
// meaning "a post-turn caller or a replay" — for what is really a missing credential.
{
  const env = { DISPATCHER_SHARED_SECRET: 'v1.previous-turn.sig' };
  const had = applyDispatcherToken({}, env);
  check('DELETES a stale token when this turn has none', !('DISPATCHER_SHARED_SECRET' in env));
  check('reports that no token was present', had === false);
}

{
  const env = { DISPATCHER_SHARED_SECRET: 'v1.previous.sig' };
  applyDispatcherToken(null, env);
  check('a payload with no input at all also clears it', !('DISPATCHER_SHARED_SECRET' in env));
}

// A non-string (or empty) token is not a credential — treating it as one would set the header to
// "undefined" and produce `unknown` at the dispatcher, i.e. the forged-token alarm.
{
  for (const bad of [null, '', 0, {}, []]) {
    const env = { DISPATCHER_SHARED_SECRET: 'v1.previous.sig' };
    applyDispatcherToken({ dispatcherToken: bad }, env);
    check(`a ${JSON.stringify(bad)} token clears rather than sets`, !('DISPATCHER_SHARED_SECRET' in env));
  }
}

// Each turn's value replaces the last: the reason dispatcher-client and slack-reply-plugin must read
// the variable per call rather than capture it.
{
  const env = {};
  applyDispatcherToken({ dispatcherToken: 'v1.turn-1.sig' }, env);
  applyDispatcherToken({ dispatcherToken: 'v1.turn-2.sig' }, env);
  check('a later turn overwrites an earlier turn\'s token', env.DISPATCHER_SHARED_SECRET === 'v1.turn-2.sig');
}

console.log(ok ? 'ALL PASS' : 'FAILURES');
process.exit(ok ? 0 : 1);
