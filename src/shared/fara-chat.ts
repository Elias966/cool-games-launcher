// Fara is trained on Nous JSON calls, not Qwen3.5's XML function syntax.
// Render its published protocol without the server's incompatible tool parser.
import official from './fara15-system-prompt.json';

/** Microsoft's Fara1.5 system prompt, verbatim, for the installed model size. */
export function faraSystemPrompt(parameters?:number){
  return parameters&&parameters!==9?official.prompt.replace(`on top of ${official.baseModel}`,`on top of Qwen3.5-${parameters}B`):official.prompt;
}

export function faraMessages(messages:any[],tools:any[]){
  const format='You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n'+tools.map(tool=>JSON.stringify(tool.function)).join('\n')+'\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';
  return messages.map(message=>{
    // The verbatim Fara prompt already carries its trained tool definition.
    if(message.role==='system')return {role:'system',content:String(message.content).includes('<tools>')?message.content:message.content+'\n\n'+format};
    if(message.role==='tool')return {role:'user',content:'<tool_response>\n'+message.content+'\n</tool_response>'};
    // The reference Fara trajectory preserves its full assistant turn.
    // Keep the model's own raw tool-call text when present (exact training format).
    if(message.role==='assistant')return {role:'assistant',content:(message.reasoning_content?'<think>\n'+message.reasoning_content+'\n</think>\n\n':'')+(message.content??'')+(String(message.content??'').includes('<tool_call>')?'':(message.tool_calls??[]).map((call:any)=>'\n<tool_call>\n'+JSON.stringify({name:call.function.name,arguments:typeof call.function.arguments==='string'?JSON.parse(call.function.arguments):call.function.arguments})+'\n</tool_call>').join(''))};
    return message;
  });
}
export function parseFaraCall(content:string,allowed:string[]){
  try {
  const matches=[...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)];
  if(matches.length!==1)throw Error('Fara must return exactly one native tool call; no browser action was taken.');
  const call=JSON.parse(matches[0][1]);
  if(!allowed.includes(call.name)||!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments))throw Error('Fara returned an unsupported native tool call.');
  return {name:call.name,arguments:JSON.stringify(call.arguments)};
  } catch (error) {
    throw Object.assign(new Error('Fara returned an invalid tool response; no browser action was taken. '+(error as Error).message), {code:'agent-response'});
  }
}
