import { fail } from './errors.mjs';
import { normalizeMedia } from './media.mjs';

// Match only whole, known holding messages. Do not infer answer quality from
// individual words or strip quotes: explanations and quotations are results too.
const acknowledgment = '(?:收到(?:你的消息|您的消息)?了?|好的|明白了?)';
const working = '(?:(?:我)?正在(?:处理|思考|查询|排查|验证|生成)(?:中)?|(?:这个问题)?我需要(?:认真)?(?:想一下|思考一下))';
const later = '(?:(?:我会)?(?:稍后|一会儿?)(?:再)?(?:给你|给您)(?:一个)?(?:完整|详细|最终)?(?:答复|回复|结果|答案))';
const wait = '(?:请(?:稍等|稍候|耐心等待))';
const chinese = new RegExp(`^(?:${acknowledgment})?(?:${working}(?:${wait})?(?:${later})?|${later}|${wait})(?:${wait})?$`, 'u');
const englishWorking = "(?:(?:i(?:'|’)?m|iam|weare)?workingonit|(?:i(?:'|’)?m|iam)?processingyourrequest|ineed(?:some|more)timetothink)";
const englishLater = "(?:(?:i(?:'|’)?ll|iwill)(?:getbacktoyou(?:soon|later)?|(?:send|give)you(?:a)?(?:full|complete|detailed)?(?:answer|response|reply)(?:soon|later)?))";
const english = new RegExp(`^(?:gotit|okay|ok|understood)?(?:${englishWorking}(?:pleasewait)?(?:${englishLater})?|${englishLater}|pleasewait)(?:pleasewait)?$`, 'u');

export function rejectPlaceholderFinal({ text, media }) {
  if (typeof text !== 'string') return; // Ordinary send validation reports invalid types.
  const normalized = text.normalize('NFKC').replace(/[\s\p{Cf}。，、,.!！;；:：…]/gu, '').toLowerCase();
  if (!chinese.test(normalized) && !english.test(normalized)) return;
  // Attachments can be the actual result. The send path still validates and
  // snapshots every file before sending the caption or acknowledging anything.
  if (normalizeMedia(media).length) return;
  fail('placeholder_final_reply', 'Final reply contains only a known holding message. Keep the original task and submit the verified result; do not acknowledge or relabel this text as progress.', 422,
    { submitted: false, event_completed: false });
}

// A narrow last guard, not a semantic quality checker. Technical explanations
// explicitly requested by the user remain possible; live credentials never do.
export function rejectInternalReply(body, event, bridge) {
  if (typeof body.text !== 'string') return;
  const secrets = [body.lease_token, body.session_token, bridge.config.api_token,
    bridge.store.get('session')?.bot_token];
  if (secrets.some((secret) => typeof secret === 'string' && secret.length >= 24 && body.text.includes(secret))) {
    fail('reply_contains_credential', 'Reply contains an active private credential. Revise the answer before submission.', 422, { submitted: false, event_completed: false });
  }
  const technicalQuestion = /worker|租约|并发|架构|源[码代]|底层|部署|桥接|协议|调试|日志|任务调度|程序|项目|实现原理|技术栈|muse-link/iu.test(event.text ?? '');
  const narration = /(?:我是|本次由|当前由|i am|i'm)\s*(?:常驻\s*)?worker[\s_-]*\d|\bmuse-link\s+muse\s+(?:next|renew|checkpoint)|\blease_token\b|\bHATCH_HOOK_RESULT\b|\.local\/state\/muse-link-worker/iu.test(body.text);
  if (!technicalQuestion && narration) fail('reply_contains_internal_narration', 'Answer the user task without internal role, lease, protocol or private-path narration.', 422, { submitted: false, event_completed: false });
}
