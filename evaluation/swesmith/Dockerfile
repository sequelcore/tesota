# SWE-smith's harness for `run.py`, at the commit the findings evaluation (#375) was built on.
# SWE-bench's harness imports Unix-only modules, so it runs here rather than on the host.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/SWE-bench/SWE-smith.git /opt/SWE-smith \
  && git -C /opt/SWE-smith checkout 9b74ac08118a85c39c356802f7961893af73e07f
RUN pip install --no-cache-dir -e "/opt/SWE-smith[validate]" docker==7.1.0 "swebench==4.1.0" pyarrow==21.0.0
COPY run.py /opt/run.py
WORKDIR /work
