/** Compare literal model/version mentions without treating typographic
 * separators as a different model. No expected text is used to recover a
 * missing name, version or occurrence; the existing full-speech gates still
 * inspect suffix words such as Flash/Pro and every original heard character. */
export function lessonModelVersionSpans(text:string){
  // The sole one-letter form is an explicit V+decimal version marker. Do not
  // turn mathematical e/x variables or arbitrary letter-number labels into NER.
  // A prefix inside an already recognized numeric identifier suffix is not
  // another model. Preserve real consecutive families: Fable5.1Opus5.5.
  const pattern=/(?<![A-Za-z])([A-Za-z]{2,}(?:-[A-Za-z]+)*(?:\s+[A-Za-z])?|[Vv](?=[\s-]*[\d零〇一二两三四五六七八九十百千万亿]+[.点]))[\s-]*([\d零〇一二两三四五六七八九十百千万亿]+(?:[.点][\d零〇一二三四五六七八九]+)?)/gd;
  const candidates=[...text.matchAll(pattern)].map(match=>{
    const end=match.index!+match[0].length;
    // Preserve the full numeric identifier suffix. Only its spaces/hyphens
    // are typographic; 24B-A2B must never become 25B-A2B or 24B-BA2.
    // A whitespace-separated GPT5 is another model, not a routing suffix.
    const number='[\\d零〇一二两三四五六七八九十百千万亿]+',part='[A-Za-z\\d零〇一二两三四五六七八九十百千万亿]';
    const suffix=new RegExp(`^[\\s-]+(${number}[A-Za-z]${part}*(?:(?:\\s*-\\s*${part}+)|(?:\\s+(?:[A-Za-z]${number}[A-Za-z]?|${number}[A-Za-z]${part}*)))*)`).exec(text.slice(end));
    return {model:match[1].replace(/[\s-]/g,'').toLowerCase(),prefix:match[1],version:match[2],start:match.index!,versionStart:match.indices![2]![0],end,...(suffix?{suffix:suffix[1],suffixStart:end+suffix[0].indexOf(suffix[1]),identifierEnd:end+suffix[0].length}:{})};
  });
  return candidates.filter(value=>!candidates.some(parent=>parent.start<value.start&&parent.suffixStart!==undefined&&value.start>=parent.suffixStart&&value.start<parent.identifierEnd!));
}
export function lessonModelVersions(text:string,normalizeVersion:(value:string)=>string):string[]{
  const suffixNumber=(value:string)=>/^[0零〇][\d零〇一二两三四五六七八九]+$/.test(value)?[...value].map(normalizeVersion).join(''):normalizeVersion(value);
  return lessonModelVersionSpans(text).map(match=>match.model+':'+normalizeVersion(match.version)+(match.suffix?':'+match.suffix.replace(/[\d零〇一二两三四五六七八九十百千万亿]+/g,suffixNumber).replace(/[\s-]/g,'').toLowerCase():''));
}
