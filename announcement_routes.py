from flask import Blueprint, jsonify, request, Response
from pathlib import Path
import json
import threading
import announcement_engine as ae

ann_bp = Blueprint('announcements', __name__)
DB_PATH = Path(__file__).parent / "asx_trader.db"

try:
    ae.init_db(DB_PATH)
except Exception as e:
    print(f"[announcement_routes] init_db error: {e}")


@ann_bp.route('', methods=['GET'])
def get_announcements():
    try:
        tickers_raw = request.args.get('tickers', '')
        tickers = [t.strip() for t in tickers_raw.split(',') if t.strip()] if tickers_raw else []
        days = int(request.args.get('days', 7))
        ann_type = request.args.get('type')
        sentiment = request.args.get('sentiment')
        limit = int(request.args.get('limit', 100))

        items = ae.get_announcements(
            db_path=DB_PATH,
            tickers=tickers or None,
            days=days,
            type_filter=ann_type,
            sentiment_filter=sentiment,
            limit=limit,
        )

        for item in items:
            if isinstance(item.get('tags'), str):
                try:
                    item['tags'] = json.loads(item['tags'])
                except (json.JSONDecodeError, TypeError):
                    item['tags'] = []

        return jsonify({"items": items, "count": len(items)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@ann_bp.route('/sync', methods=['POST'])
def sync_announcements():
    try:
        body = request.get_json(silent=True) or {}
        tickers = body.get('tickers') or []
        if not tickers:
            return jsonify({"ok": False, "error": "tickers required"}), 400

        days = body.get('days', 3)
        settings = body.get('settings', {})

        status = ae.get_sync_status()
        if status.get('running'):
            return jsonify({"ok": False, "error": "Sync already running"}), 409

        def run():
            ae.run_sync(tickers, settings=settings, days=days, db_path=DB_PATH)

        t = threading.Thread(target=run, daemon=True)
        t.start()

        return jsonify({"ok": True, "message": f"Sync started for {len(tickers)} tickers"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@ann_bp.route('/status', methods=['GET'])
def sync_status():
    try:
        status = ae.get_sync_status()
        with ae.get_db(DB_PATH) as conn:
            row = conn.execute("SELECT COUNT(*) FROM announcements").fetchone()
            total = row[0] if row else 0
        status['total_in_db'] = total
        return jsonify(status)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@ann_bp.route('/<ann_id>/pdf', methods=['GET'])
def get_pdf(ann_id):
    try:
        pdf_url = ae.get_announcement_pdf_url(ann_id, DB_PATH)
        if pdf_url is None:
            return jsonify({"error": "Announcement not found"}), 404
        if not pdf_url:
            return jsonify({"error": "No PDF URL stored"}), 404

        pdf_bytes = ae.download_pdf(pdf_url)
        if pdf_bytes is None:
            return jsonify({"error": "Failed to download PDF"}), 502

        return Response(
            pdf_bytes,
            content_type='application/pdf',
            headers={'Content-Disposition': f'inline; filename="{ann_id}.pdf"'},
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


DEFAULT_SETTINGS = {
    "ann_llm_provider": "ollama",
    "ann_llm_model": "qwen2.5:1.5b",
    "ollama_url": "http://localhost:11434",
    "groq_api_key": "",
    "gemini_api_key": "",
}


@ann_bp.route('/settings', methods=['GET'])
def get_settings():
    try:
        with ae.get_db(DB_PATH) as conn:
            row = conn.execute("SELECT value FROM blob_store WHERE key='ann_settings'").fetchone()
        if row:
            return jsonify(json.loads(row[0]))
        return jsonify(DEFAULT_SETTINGS)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@ann_bp.route('/settings', methods=['POST'])
def save_settings():
    try:
        data = request.get_json(silent=True) or {}
        with ae.get_db(DB_PATH) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?,?,datetime('now'))",
                ('ann_settings', json.dumps(data)),
            )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
