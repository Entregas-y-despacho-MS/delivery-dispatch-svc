#!/usr/bin/env bash
set -euo pipefail

: "${PUBSUB_PROJECT_ID:?Set PUBSUB_PROJECT_ID to the Google Cloud project ID.}"
: "${PUBSUB_INBOUND_TOPIC:?Set PUBSUB_INBOUND_TOPIC to the existing shared topic ID.}"
: "${PUBSUB_INBOUND_SUBSCRIPTION:?Set PUBSUB_INBOUND_SUBSCRIPTION to the subscription ID for this backend.}"
# Optional: PUBSUB_SERVICE_ACCOUNT=<e-mail of the backend service account> grants it the minimum roles (see below).

if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud CLI is required to provision the Pub/Sub subscription." >&2
    exit 1
fi

project="$PUBSUB_PROJECT_ID"
topic="$PUBSUB_INBOUND_TOPIC"
subscription="$PUBSUB_INBOUND_SUBSCRIPTION"
expected_topic="projects/${project}/topics/${topic}"
broker_dead_letter="${topic}.delivery-failures"

# The input topic belongs to the publisher and must already exist.
gcloud pubsub topics describe "$topic" --project="$project" >/dev/null
if ! gcloud pubsub topics describe "$broker_dead_letter" --project="$project" >/dev/null 2>&1; then
    gcloud pubsub topics create "$broker_dead_letter" --project="$project"
fi
project_number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
pubsub_agent="service-${project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
gcloud pubsub topics add-iam-policy-binding "$broker_dead_letter" \
    --project="$project" \
    --member="serviceAccount:${pubsub_agent}" \
    --role="roles/pubsub.publisher" \
    --quiet >/dev/null

if gcloud pubsub subscriptions describe "$subscription" --project="$project" >/dev/null 2>&1; then
    actual_topic="$(gcloud pubsub subscriptions describe "$subscription" --project="$project" --format='value(topic)')"
    if [[ "$actual_topic" != "$expected_topic" ]]; then
        echo "Subscription $subscription is attached to $actual_topic, expected $expected_topic." >&2
        exit 1
    fi
    echo "Subscription $subscription already exists on $expected_topic."
else
    gcloud pubsub subscriptions create "$subscription" \
        --project="$project" \
        --topic="$topic" \
        --ack-deadline=30 \
        --dead-letter-topic="$broker_dead_letter" \
        --max-delivery-attempts=5 \
        --min-retry-delay=10s \
        --max-retry-delay=600s
fi
gcloud pubsub subscriptions add-iam-policy-binding "$subscription" \
    --project="$project" \
    --member="serviceAccount:${pubsub_agent}" \
    --role="roles/pubsub.subscriber" \
    --quiet >/dev/null

create_topic_if_missing() {
    local name="$1"
    if ! gcloud pubsub topics describe "$name" --project="$project" >/dev/null 2>&1; then
        gcloud pubsub topics create "$name" --project="$project"
    fi
}

# The app publishes schema rejections to each logical input topic's dead-letter topic, and the messages it
# sends (the acknowledgements of a CRM complaint among them) to the `dispatch.*` topics. Despachos owns both
# kinds; the consumers of `dispatch.*` create their own subscriptions.
dead_letter_topics=("${topic}.dead-letter")
outbound_topics=()
create_topic_if_missing "${topic}.dead-letter"
shopt -s nullglob
for schema in contracts/messages/schemas/*.schema.json; do
    filename="${schema##*/}"
    logical_topic="${filename%.schema.json}"
    if [[ "$logical_topic" == dispatch.* ]]; then
        create_topic_if_missing "$logical_topic"
        outbound_topics+=("$logical_topic")
        continue
    fi
    create_topic_if_missing "${logical_topic}.dead-letter"
    dead_letter_topics+=("${logical_topic}.dead-letter")
done

# The CRM complaint flow (ES-298) is not optional: the complaint arrives through the shared input topic (routed by
# its `type`), is rejected into its dead-letter topic and is answered on the two acknowledgement topics.
for required in crm.delivery_complaint.opened.dead-letter     dispatch.delivery_complaint.received dispatch.delivery_complaint.rejected; do
    if ! gcloud pubsub topics describe "$required" --project="$project" >/dev/null 2>&1; then
        echo "Required topic $required does not exist after setup (is its schema in contracts/messages/schemas?)." >&2
        exit 1
    fi
done

# Least privilege for the backend identity, per resource and never per project: it consumes ONE subscription and
# publishes ONLY to the dead-letter topics and to `dispatch.*`. It needs no role on the shared input topic (the
# publisher owns it) and no admin role. Pass the e-mail of its service account; no key or secret is handled here.
service_account="${PUBSUB_SERVICE_ACCOUNT:-}"
if [[ -n "$service_account" ]]; then
    grant() {
        gcloud pubsub "$1" add-iam-policy-binding "$2"             --project="$project"             --member="serviceAccount:${service_account}"             --role="$3"             --quiet >/dev/null
    }
    grant subscriptions "$subscription" roles/pubsub.subscriber
    for name in "${dead_letter_topics[@]}" "${outbound_topics[@]}"; do
        grant topics "$name" roles/pubsub.publisher
    done
    echo "Granted ${service_account}: Subscriber on $subscription; Publisher on ${#dead_letter_topics[@]} dead-letter and ${#outbound_topics[@]} dispatch.* topics."
else
    echo "PUBSUB_SERVICE_ACCOUNT is not set: no role was granted to the backend identity."
    echo "Set it to the service account e-mail, or grant Pub/Sub Subscriber on $subscription and Pub/Sub Publisher on the dead-letter and dispatch.* topics by hand."
fi

echo "Ready. Configure the backend with this project, topic and subscription, and unset PUBSUB_EMULATOR_HOST."
echo "Granted the Pub/Sub service agent Subscriber on $subscription and Publisher on $broker_dead_letter for retry exhaustion."
echo "Existing subscriptions are checked but their retry/dead-letter policy is not changed by this script."
