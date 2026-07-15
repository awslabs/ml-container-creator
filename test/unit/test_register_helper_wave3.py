from __future__ import annotations
"""Tests for E6 Wave 3: hub listing, row count, technique guardrail."""

import json
import os
import sys
import struct
import tempfile
import unittest
from unittest.mock import MagicMock, patch, call
import importlib.util

REGISTER_HELPER = os.path.join(
    os.path.dirname(__file__), '..', '..', 'templates', 'do', '.register_helper.py'
)
TUNE_HELPER = os.path.join(
    os.path.dirname(__file__), '..', '..', 'templates', 'do', '.tune_helper.py'
)


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    # Prevent sys.exit() during import
    with patch('sys.exit'):
        spec.loader.exec_module(mod)
    return mod


# Load modules once — they may call sys.exit on _output, so we patch it
_reg_mod = None
_tune_mod = None


def _get_reg():
    global _reg_mod
    if _reg_mod is None:
        _reg_mod = _load_module(REGISTER_HELPER, 'register_helper')
    return _reg_mod


def _get_tune():
    global _tune_mod
    if _tune_mod is None:
        _tune_mod = _load_module(TUNE_HELPER, 'tune_helper')
    return _tune_mod


class TestParseTechniqueFromDescription(unittest.TestCase):
    def test_parse_technique_from_description(self):
        mod = _get_reg()
        result = mod._parse_technique_from_description('[hash:abc123] [technique:sft] my dataset')
        self.assertEqual(result, 'sft')

    def test_parse_technique_unknown(self):
        mod = _get_reg()
        result = mod._parse_technique_from_description('some description without tag')
        self.assertEqual(result, 'unknown')

    def test_parse_technique_dpo(self):
        mod = _get_reg()
        result = mod._parse_technique_from_description('[technique:dpo]')
        self.assertEqual(result, 'dpo')

    def test_parse_technique_none_input(self):
        mod = _get_reg()
        result = mod._parse_technique_from_description(None)
        self.assertEqual(result, 'unknown')


class TestListHubDatasets(unittest.TestCase):
    @patch('boto3.client')
    def test_list_hub_datasets_success(self, mock_boto_client):
        mod = _get_reg()
        mock_sm = MagicMock()
        mock_boto_client.return_value = mock_sm
        mock_sm.list_hub_contents.return_value = {
            'HubContentSummaries': [
                {
                    'HubContentName': 'dataset-a',
                    'HubContentVersion': '1.0',
                    'HubContentDescription': '[technique:sft] training data',
                    'CreationTime': '2026-01-01T00:00:00Z',
                },
                {
                    'HubContentName': 'dataset-b',
                    'HubContentVersion': '2.0',
                    'HubContentDescription': '[technique:dpo] preference pairs',
                    'CreationTime': '2026-02-01T00:00:00Z',
                },
            ],
            # No NextToken means single page
        }

        results = mod._list_hub_datasets('my-hub', 'us-west-2')
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['name'], 'dataset-a')
        self.assertEqual(results[0]['technique'], 'sft')
        self.assertEqual(results[0]['origin'], 'remote')
        self.assertEqual(results[1]['name'], 'dataset-b')
        self.assertEqual(results[1]['technique'], 'dpo')
        self.assertEqual(results[1]['version'], '2.0')

    @patch('boto3.client')
    def test_list_hub_datasets_error(self, mock_boto_client):
        mod = _get_reg()
        mock_sm = MagicMock()
        mock_boto_client.return_value = mock_sm
        mock_sm.list_hub_contents.side_effect = Exception('AccessDenied')

        results = mod._list_hub_datasets('my-hub', 'us-west-2')
        self.assertEqual(results, [])


class TestCountNewlinesStreaming(unittest.TestCase):
    def test_count_newlines_streaming(self):
        mod = _get_reg()
        mock_s3 = MagicMock()
        # Return data with 3 newlines in one chunk (smaller than 1MB)
        body_mock = MagicMock()
        body_mock.read.return_value = b'a\nb\nc\n'
        mock_s3.get_object.return_value = {'Body': body_mock}

        result = mod._count_newlines_streaming(mock_s3, 'bucket', 'key.jsonl')
        self.assertEqual(result, 3)


class TestCountRows(unittest.TestCase):
    @patch('boto3.client')
    def test_count_rows_jsonl(self, mock_boto_client):
        mod = _get_reg()
        mock_s3 = MagicMock()
        mock_boto_client.return_value = mock_s3
        body_mock = MagicMock()
        body_mock.read.return_value = b'{"a":1}\n{"a":2}\n{"a":3}\n'
        mock_s3.get_object.return_value = {'Body': body_mock}

        result = mod._count_rows('s3://bucket/data/train.jsonl', 'us-west-2')
        self.assertEqual(result, 3)

    @patch('boto3.client')
    def test_count_rows_csv_subtracts_header(self, mock_boto_client):
        mod = _get_reg()
        mock_s3 = MagicMock()
        mock_boto_client.return_value = mock_s3
        body_mock = MagicMock()
        # 3 newlines: header + 2 data rows
        body_mock.read.return_value = b'col1,col2\nval1,val2\nval3,val4\n'
        mock_s3.get_object.return_value = {'Body': body_mock}

        result = mod._count_rows('s3://bucket/data/train.csv', 'us-west-2')
        self.assertEqual(result, 2)

    @patch('boto3.client')
    def test_count_rows_parquet_extracts_num_rows(self, mock_boto_client):
        mod = _get_reg()
        mock_s3 = MagicMock()
        mock_boto_client.return_value = mock_s3

        # Build a synthetic Parquet footer tail
        # PAR1 magic + footer_len (little-endian 4 bytes)
        num_rows = 42
        # Thrift encoding: field id=1, type i64 (0x0A), then big-endian i64
        thrift_marker = b'\x0a\x00\x01'
        num_rows_bytes = struct.pack('>q', num_rows)
        footer_content = thrift_marker + num_rows_bytes + b'\x00' * 20
        footer_len = len(footer_content)
        footer_len_bytes = struct.pack('<I', footer_len)
        magic = b'PAR1'
        tail_8 = footer_len_bytes + magic

        # First call: get last 8 bytes
        body_tail = MagicMock()
        body_tail.read.return_value = tail_8

        # Second call: get footer + 8 bytes
        body_footer = MagicMock()
        body_footer.read.return_value = footer_content + footer_len_bytes + magic

        mock_s3.get_object.side_effect = [
            {'Body': body_tail},
            {'Body': body_footer},
        ]

        result = mod._count_rows('s3://bucket/data/train.parquet', 'us-west-2')
        self.assertEqual(result, 42)

    @patch('boto3.client')
    def test_count_rows_unsupported(self, mock_boto_client):
        mod = _get_reg()
        result = mod._count_rows('s3://bucket/data/model.pkl', 'us-west-2')
        self.assertIsNone(result)


class TestCheckTechniqueMismatch(unittest.TestCase):
    def _make_registry(self, tmpdir, dataset_name, technique):
        """Create a local registry file with one dataset entry."""
        registry_dir = os.path.join(tmpdir, '.ml-container-creator')
        os.makedirs(registry_dir, exist_ok=True)
        registry_path = os.path.join(registry_dir, 'datasets.json')
        entries = [{
            'name': dataset_name,
            'technique': technique,
            'versions': [{'version': '1.0.0', 'technique': technique}],
        }]
        with open(registry_path, 'w') as f:
            json.dump(entries, f)
        return registry_path

    def test_check_technique_mismatch_warning(self):
        """Local registry has sft, current=dpo → warning printed, no exit."""
        mod = _get_tune()
        with tempfile.TemporaryDirectory() as tmpdir:
            self._make_registry(tmpdir, 'my-dataset', 'sft')
            with patch.object(os.path, 'expanduser', return_value=tmpdir):
                import io
                stderr_capture = io.StringIO()
                with patch('sys.stderr', stderr_capture):
                    with patch.dict(os.environ, {}, clear=False):
                        # Should NOT exit
                        mod._check_technique_mismatch('my-dataset', 'dpo', 'us-west-2')
                output = stderr_capture.getvalue()
                self.assertIn('registered for technique', output)
                self.assertIn('sft', output)
                self.assertIn('dpo', output)

    def test_check_technique_mismatch_auto_mode(self):
        """MLCC_AUTO_MODE=1, mismatch → sys.exit(4)."""
        mod = _get_tune()
        with tempfile.TemporaryDirectory() as tmpdir:
            self._make_registry(tmpdir, 'my-dataset', 'sft')
            with patch.object(os.path, 'expanduser', return_value=tmpdir):
                with patch.dict(os.environ, {'MLCC_AUTO_MODE': '1'}, clear=False):
                    with self.assertRaises(SystemExit) as ctx:
                        mod._check_technique_mismatch('my-dataset', 'dpo', 'us-west-2')
                    self.assertEqual(ctx.exception.code, 4)

    def test_check_technique_match(self):
        """Same technique → no warning, no exit."""
        mod = _get_tune()
        with tempfile.TemporaryDirectory() as tmpdir:
            self._make_registry(tmpdir, 'my-dataset', 'sft')
            with patch.object(os.path, 'expanduser', return_value=tmpdir):
                import io
                stderr_capture = io.StringIO()
                with patch('sys.stderr', stderr_capture):
                    # Should NOT exit and NOT warn
                    mod._check_technique_mismatch('my-dataset', 'sft', 'us-west-2')
                output = stderr_capture.getvalue()
                self.assertNotIn('registered for technique', output)


if __name__ == '__main__':
    unittest.main()
