"""Exercise a fresh local database and the explicit simulation workflow."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import app as module


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.old_database = module.app.config['DATABASE']
        self.old_uploads = module.app.config['UPLOAD_FOLDER']
        module.app.config.update(TESTING=True, DATABASE=str(root / 'test.db'), UPLOAD_FOLDER=str(root))
        module.init_db()
        self.client = module.app.test_client()

    def tearDown(self):
        module.app.config.update(DATABASE=self.old_database, UPLOAD_FOLDER=self.old_uploads)
        self.temp.cleanup()

    def test_pages_and_static_resources(self):
        for url in ('/', '/panel', '/analytics', '/schedule', '/workorders', '/static/css/style.css', '/static/js/app.js'):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                response.close()

    def test_explicit_simulation_persists_and_exports(self):
        response = self.client.post('/api/inspect', data={'panel_id': 'DEMO-01', 'model': 'yolov26', 'sim_mode': 'true'})
        data = response.get_json()
        self.assertTrue(data['success'], data)
        self.assertTrue(data['sim_mode'])
        boundary = self.client.post('/api/inspect', data={'confidence': '1', 'sim_mode': 'true'}).get_json()
        self.assertTrue(boundary['success'], boundary)
        self.assertGreaterEqual(data['health_score'], 0)
        self.assertLessEqual(data['health_score'], 100)
        for url in ('/api/status', '/api/results', '/api/analytics', '/api/schedule', '/api/workorders', '/api/farm', '/api/export/csv', '/api/export/json', '/api/report?panel_id=DEMO-01'):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                if response.is_json:
                    self.assertNotIn('error', response.get_json())

    def test_missing_weights_are_not_presented_as_real_predictions(self):
        with patch.object(module, 'load_model', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'weights'):
                module.real_inference('unused.png', 'yolov26')

    def test_invalid_request_rejected(self):
        for data in ({'confidence': '2'}, {'confidence': '-1'}, {'confidence': 'not-a-number'}, {'confidence': 'nan'}, {'model': 'unknown'}):
            self.assertEqual(self.client.post('/api/inspect', data=data).status_code, 400)
        response = self.client.post('/api/inspect', data={'image': (io.BytesIO(b'bad'), 'bad.exe')})
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
