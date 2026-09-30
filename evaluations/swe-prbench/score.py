"""Score Tesota's SWE-PRBench answers with the benchmark's own code (decision 023).

`bun run live:prbench` writes one answer per task. This script passes each
answer through the harness's own parser, GPT-5.2 judge, scorer and report,
exactly as `eval_harness/run_eval.py` does for the models it calls itself;
only the step that calls a model is replaced by reading Tesota's answer.

Run it with the harness's environment, from Tesota's repository root:

    live-runs/swe-prbench/.venv/Scripts/python evaluations/swe-prbench/score.py --label <label>

The judge's OPENAI_API_KEY is read from `live-runs/swe-prbench/harness/.env`
or the environment, as the harness reads it. Results go under
`live-runs/swe-prbench/results/<label>-<response>__judge_gpt_5_2/`, in the
harness's own layout, ending with `eval_report.json`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import asdict
from pathlib import Path

PIPELINE_VERSION = "v0.4.1"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default="live-runs/swe-prbench", help="Directory holding harness/, data/ and answers/")
    parser.add_argument("--label", required=True, help="The answers' label, as live:prbench wrote them")
    parser.add_argument("--response", choices=["refuted", "unrefuted"], default="refuted",
                        help="Score what Tesota shows after refutation, or what its reviewers raised before it")
    parser.add_argument("--judge", default="gpt_5_2", help="Judge model id in the harness configuration")
    parser.add_argument("--split", default="eval_100",
                        help="The PR records under the dataset's evals/, as passed to the harness's --prs")
    args = parser.parse_args()

    root = Path(args.root)
    harness = root / "harness"
    version = (harness / "pipeline_version.txt").read_text(encoding="utf-8").strip()
    if version != PIPELINE_VERSION:
        sys.exit(f"The harness is at pipeline {version}; these scores are defined for {PIPELINE_VERSION}.")
    sys.path.insert(0, str(harness))

    # Importing run_eval loads the harness's .env, as its own runs do.
    from eval_harness import run_eval  # noqa: F401
    from eval_harness.assembler import assemble_eval_result
    from eval_harness.io_utils import write_json
    from eval_harness.judge import run_judge
    from eval_harness.loader import load_eval_input
    from eval_harness.model_clients import ModelRouter
    from eval_harness.rebuild_report import rebuild_run_report
    from eval_harness.runner import build_agent_output_from_raw
    from eval_harness.schema import AgentOutput, HumanCommentStatus, JudgeOutput
    from eval_harness.scorer import compute_dimension_scores

    config = harness / "eval_harness" / "model_endpoints.yaml"
    if not config.exists():
        shutil.copyfile(harness / "eval_harness" / "model_endpoints.example.yaml", config)
    router = ModelRouter.from_config_file(str(config))

    data = root / "data" / "dataset"
    answers = sorted((root / "answers" / args.label).glob("*_config_*.json"))
    if not answers:
        sys.exit(f"No answers under {root / 'answers' / args.label}; run bun run live:prbench first.")
    agent = f"{args.label}-{args.response}"
    run_root = root / "results" / f"{agent}__judge_{args.judge}"
    for part in ("agent_outputs", "judge_outputs", "eval_results"):
        (run_root / part).mkdir(parents=True, exist_ok=True)

    for number, path in enumerate(answers, start=1):
        stem = path.stem
        if (run_root / "eval_results" / f"{stem}_eval.json").exists():
            continue
        answer = json.loads(path.read_text(encoding="utf-8"))
        eval_input = load_eval_input(answer["task_id"], answer["config_name"], str(data / "contexts"),
                                     str(data / "annotations"), str(data / "evals" / f"{args.split}.json"))
        raw = answer["raw_response" if args.response == "refuted" else "unrefuted_response"]
        try:
            agent_output = build_agent_output_from_raw(eval_input, agent, raw)
        except Exception as error:  # the harness's own treatment of an answer it cannot parse
            agent_output = AgentOutput(task_id=eval_input.task_id, config_name=eval_input.config_name, model=agent,
                                       raw_response=raw, comments=[], parse_success=False, parse_error=str(error))
        if agent_output.parse_success:
            judge_output = run_judge(eval_input, agent_output, args.judge, router)
        else:
            # As run_eval.py's strict mode: an unparseable answer misses every human comment and is not judged.
            judge_output = JudgeOutput(
                task_id=eval_input.task_id, config_name=eval_input.config_name, agent_classifications=[],
                human_comment_statuses=[HumanCommentStatus(comment_id=str(c.get("comment_id") or ""), status="MISSED",
                                                           matched_agent_comment_id=None)
                                        for c in eval_input.human_comments],
                judge_model=args.judge, judge_prompt_version="v1.0+agent_parse_failed")
        scores = compute_dimension_scores(eval_input, agent_output, judge_output)
        result = assemble_eval_result(eval_input, agent_output, judge_output, scores, f"{agent}::judge={args.judge}")
        write_json(asdict(agent_output), run_root / "agent_outputs" / f"{stem}_agent.json")
        write_json(asdict(judge_output), run_root / "judge_outputs" / f"{stem}_judge.json")
        write_json(asdict(result), run_root / "eval_results" / f"{stem}_eval.json")
        print(f"{number}/{len(answers)} {stem}: overall {result.overall_score:.3f}, "
              f"caught {result.caught_human_comments} of {result.total_human_comments}", flush=True)

    count, report_path = rebuild_run_report(run_root)
    print(f"{count} results; report {report_path}")


if __name__ == "__main__":
    main()
