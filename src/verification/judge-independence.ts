export type JudgeIndependence = "same_model" | "same_lab" | "independent";

/**
 * Decision 028's rule for a role that judges another's output. A judge on
 * the same model as the author is warned about most: evaluators favor their
 * own output even on objective code criteria. A judge from the same lab is
 * noted: a smaller same-family preference is measured. Otherwise the pair is
 * independent. The same model is always the same lab.
 */
//@ requires !sameModel || sameLab
//@ ensures sameModel ==> \result === "same_model"
//@ ensures !sameModel && sameLab ==> \result === "same_lab"
//@ ensures !sameLab ==> \result === "independent"
export function judgeIndependence(sameModel: boolean, sameLab: boolean): JudgeIndependence {
  if (sameModel) return "same_model";
  return sameLab ? "same_lab" : "independent";
}
