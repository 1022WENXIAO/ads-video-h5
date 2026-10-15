/** Compare literal model/version mentions without treating typographic
 * separators as a different model. No expected text is used to recover a
 * missing name, version or occurrence; the existing full-speech gates still
 * inspect suffix words such as Flash/Pro and every original heard character. */
export function lessonModelVersionSpans(text:string){
  // The sole one-letter form is an explicit V+decimal version marker. Do not
  // turn mathematical e/x variables or arbitrary letter-number labels into NER.
  const pattern=/(?<![A-Za-z])([A-Za-z]{2,}(?:-[A-Za-z]+)*(?:\s+[A-Za-z])?|[Vv](?=[\s-]*[\d零〇一二两三四五六七八九十百千万亿]+[.点]))[\s-]*([\d零〇一二两三四五六七八九十百千万亿]+(?:[.点][\d零〇一二三四五六七八九]+)?)/gd;
  return [...text.matchAll(pattern)].map(match=>({model:match[1].replace(/[\s-]/g,'').toLowerCase(),prefix:match[1],version:match[2],start:match.index!,versionStart:match.indices![2]![0],end:match.index!+match[0].length}));
}
export function lessonModelVersions(text:string,normalizeVersion:(value:string)=>string):string[]{
  return lessonModelVersionSpans(text).map(match=>match.model+':'+normalizeVersion(match.version));
}
