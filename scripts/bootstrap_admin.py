"""Grant the first GeoTrace workspace admin using trusted Firebase Admin credentials.

Run after the target person has signed in once with Google:
  python scripts/bootstrap_admin.py --email investigator@example.org --org geotrace-workspace
"""
import argparse
import os

import firebase_admin
from firebase_admin import auth, credentials, firestore


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True, help="Exact Google account email")
    parser.add_argument("--org", default="geotrace-workspace", help="Organization ID used by src/config.js")
    args = parser.parse_args()

    if not firebase_admin._apps:
        project_id = os.getenv("FIREBASE_PROJECT_ID")
        if project_id:
            firebase_admin.initialize_app(options={"projectId": project_id})
        else:
            firebase_admin.initialize_app(credentials.ApplicationDefault())

    user = auth.get_user_by_email(args.email)
    db = firestore.client()
    member_ref = db.collection("orgs").document(args.org).collection("members").document(user.uid)
    member_ref.set({
        "uid": user.uid,
        "email": user.email,
        "displayName": user.display_name or "",
        "role": "admin",
        "status": "approved",
        "createdAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
        "grantedBy": "bootstrap-script",
    }, merge=True)
    profile_ref = db.collection("profiles").document(user.uid)
    profile_ref.set({"organizationId": args.org, "accessStatus": "approved", "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
    print(f"Granted admin membership to {args.email} ({user.uid}) in {args.org}.")


if __name__ == "__main__":
    main()
