"""Run one SWE-smith instance's tests with a diff applied, for findings as evidence (#375).

Starts a container from the instance's image, whose repository is the code
before the planted bug, applies the diff from --patch-file (the bug, a
reproduction test, or both), runs the repository's test command and prints
the results its SWE-smith profile parses, as JSON. Runs inside the
tesota-swesmith image, which carries SWE-smith; see the Dockerfile here.

    python run.py --instance-file instance.json --patch-file change.diff [--timeout 900] [--out-file result.json]
        [--match "tesota repro"] [--memory 4g] [--visible-file visible.json]

With --out-file the result goes there and stdout keeps the cleanup's messages.
With --match, stdout shows only the tests whose names contain that text, and
the end of the output, as the agent sees them; with --visible-file, a JSON
list of test names, it shows which of those do not pass instead of the output.
"""

import argparse
import json
import time
from pathlib import Path

import docker
from swebench.harness.constants import DOCKER_USER, DOCKER_WORKDIR
from swebench.harness.docker_utils import cleanup_container, copy_to_container, exec_run_with_timeout
from swesmith.constants import GIT_APPLY_CMDS, KEY_PATCH
from swesmith.profiles import registry


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance-file", required=True)
    parser.add_argument("--patch-file", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--out-file")
    parser.add_argument("--match")
    parser.add_argument("--memory", default="4g")
    parser.add_argument("--visible-file")
    args = parser.parse_args()
    instance = json.loads(Path(args.instance_file).read_text(encoding="utf-8"))
    patch = Path(args.patch_file).read_text(encoding="utf-8")
    profile = registry.get_from_inst(instance)
    client = docker.from_env()
    # SWE-smith's own pull shells out to a docker command, which this image does not carry.
    try:
        client.images.get(profile.image_name)
    except docker.errors.ImageNotFound:
        client.images.pull(profile.image_name)
    container = client.containers.create(image=profile.image_name, user=DOCKER_USER, detach=True,
        command="tail -f /dev/null", platform="linux/x86_64", mem_limit=args.memory, memswap_limit=args.memory)
    result: dict = {"applied": True}
    try:
        container.start()
        if patch.strip():
            copy_to_container(container, Path(args.patch_file), Path("/tmp/change.diff"))
            result["applied"] = any(container.exec_run(f"{command} /tmp/change.diff", workdir=DOCKER_WORKDIR,
                user=DOCKER_USER).exit_code == 0 for command in GIT_APPLY_CMDS)
        if result["applied"]:
            # The test command the instance's own validation used, chosen from its planted bug's files.
            command, _ = profile.get_test_cmd({**instance, KEY_PATCH: instance["patch"]})
            script = Path(args.patch_file).with_suffix(".sh")
            script.write_text(f"#!/bin/bash\ncd {DOCKER_WORKDIR}\n{command}\n", encoding="utf-8")
            copy_to_container(container, script, Path("/eval.sh"))
            started = time.time()
            output, timed_out, _ = exec_run_with_timeout(container, "/bin/bash /eval.sh", timeout=args.timeout)
            result.update(timedOut=timed_out, seconds=round(time.time() - started, 1), statuses=profile.log_parser(output),
                tail=output[-1500:])
    finally:
        cleanup_container(client, container, None)
    if args.out_file is not None:
        Path(args.out_file).write_text(json.dumps(result), encoding="utf-8")
    if args.match is not None:
        statuses = result.get("statuses", {})
        matched = {name: status for name, status in statuses.items() if args.match.lower() in name.lower()}
        if args.visible_file is None:
            print(json.dumps({"applied": result["applied"], "tests": matched, "outputTail": result.get("tail", "")}, indent=1))
        else:
            # Only the visible tests: neither the hidden ones nor the output, which could name them.
            visible = json.loads(Path(args.visible_file).read_text(encoding="utf-8"))
            broken = [name for name in visible if statuses.get(name) != "PASSED"]
            print(json.dumps({"applied": result["applied"], "tests": matched, "otherTestsBroken": broken[:20],
                "otherTestsBrokenCount": len(broken)}, indent=1))
    elif args.out_file is None:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
