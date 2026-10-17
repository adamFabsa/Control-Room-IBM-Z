"""Stand-in for Hugging Face `datasets`, which needs pyarrow (no s390x wheel).

granite-tsfm imports datasets.Dataset when the package loads, for preprocessing helpers that
TTM forecasting here never calls.
"""


class Dataset:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError("Hugging Face datasets is not installed in this s390x image")
