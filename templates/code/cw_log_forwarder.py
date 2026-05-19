#!/usr/bin/env python3
"""CloudWatch log forwarder — workaround for IC platform log routing gap.
Pipes stdin to a CW log stream while passing through to stderr.
Usage: exec > >(python3 /usr/bin/cw_log_forwarder.py) 2>&1
"""
import sys, os, time, threading
import boto3
from botocore.config import Config

LOG_GROUP = os.environ.get("CW_LOG_GROUP",
    f"/aws/sagemaker/InferenceComponents/{os.environ.get('INFERENCE_COMPONENT_NAME', os.environ.get('HOSTNAME', 'unknown'))}")
LOG_STREAM = f"AllTraffic/{os.environ.get('HOSTNAME', 'container')}"
REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-west-2"))

def main():
    client = boto3.client("logs", region_name=REGION, config=Config(retries={"max_attempts": 2}))
    try:
        client.create_log_group(logGroupName=LOG_GROUP)
    except Exception:
        pass
    try:
        client.create_log_stream(logGroupName=LOG_GROUP, logStreamName=LOG_STREAM)
    except Exception as e:
        # Can't create stream — just passthrough
        for line in sys.stdin:
            sys.stderr.write(line)
        return

    buf, lock, seq = [], threading.Lock(), [None]

    def flush():
        with lock:
            if not buf:
                return
            batch = buf[:50]
            del buf[:50]
        events = [{"timestamp": int(t * 1000), "message": m} for t, m in batch]
        kw = {"logGroupName": LOG_GROUP, "logStreamName": LOG_STREAM, "logEvents": events}
        if seq[0]:
            kw["sequenceToken"] = seq[0]
        try:
            r = client.put_log_events(**kw)
            seq[0] = r.get("nextSequenceToken")
        except Exception:
            pass

    def loop():
        while True:
            time.sleep(2)
            flush()

    threading.Thread(target=loop, daemon=True).start()
    try:
        for line in sys.stdin:
            sys.stderr.write(line)
            with lock:
                buf.append((time.time(), line.rstrip("\n")))
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        flush()

if __name__ == "__main__":
    main()
